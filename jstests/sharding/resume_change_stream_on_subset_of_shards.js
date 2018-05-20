// Designed to reproduce SERVER-32088, this tests that resuming a change stream on a sharded
// collection where not all shards have a chunk in the collection will not work.
(function() {
    "use strict";

    load("jstests/libs/change_stream_util.js");  // For ChangeStreamTest.

    // For supportsMajorityReadConcern().
    load("jstests/multiVersion/libs/causal_consistency_helpers.js");

    if (!supportsMajorityReadConcern()) {
        jsTestLog("Skipping test since storage engine doesn't support majority read concern.");
        return;
    }

    // Create a 3-shard cluster. Enable 'writePeriodicNoops' and set 'periodicNoopIntervalSecs' to 1
    // second so that each shard is continually advancing its optime, allowing the
    // AsyncResultsMerger to return sorted results even if some shards have not yet produced any
    // data.
    const st = new ShardingTest({
        shards: 3,
        rs: {nodes: 1, setParameter: {writePeriodicNoops: true, periodicNoopIntervalSecs: 1}}
    });

    const mongosDB = st.s0.getDB(jsTestName());
    const mongosColl = mongosDB.test;

    // Enable sharding on the test DB and ensure its primary is shard 0.
    assert.commandWorked(mongosDB.adminCommand({enableSharding: mongosDB.getName()}));
    st.ensurePrimaryShard(mongosDB.getName(), st.rs0.getURL());

    // Shard the test collection on _id, split the collection into 2 chunks: [MinKey, 0) and
    // [0, MaxKey), then move the [0, MaxKey) chunk to shard 1.
    assert.commandWorked(
        mongosDB.adminCommand({shardCollection: mongosColl.getFullName(), key: {_id: 1}}));
    assert.commandWorked(
        mongosDB.adminCommand({split: mongosColl.getFullName(), middle: {_id: 0}}));
    assert.commandWorked(mongosDB.adminCommand(
        {moveChunk: mongosColl.getFullName(), find: {_id: 1}, to: st.rs1.getURL()}));

    // Establish a change stream...
    const changeStream = mongosColl.aggregate([{$changeStream: {}}]);

    // ... then do one write to produce a resume token...
    assert.writeOK(mongosColl.insert({_id: -2}));
    assert.soon(() => changeStream.hasNext());
    const resumeToken = changeStream.next()._id;

    // ... followed by one write to each chunk for testing purposes, i.e. shards 0 and 1.
    assert.writeOK(mongosColl.insert({_id: -1}));
    assert.writeOK(mongosColl.insert({_id: 1}));

    // The change stream should see all the inserts after establishing cursors on all shards.
    for (let nextId of[-1, 1]) {
        assert.soon(() => changeStream.hasNext());
        let next = changeStream.next();
        assert.eq(next.operationType, "insert");
        assert.eq(next.fullDocument, {_id: nextId});
        jsTestLog(`Saw insert for _id ${nextId}`);
    }

    // Now try to resume the change stream. We expect this to fail until we resolve SERVER-32088,
    // since the collection doesn't exist on the third shard, and so it will mistakenly think that
    // it has been dropped.
    changeStream.close();
    ChangeStreamTest.assertChangeStreamThrowsCode({
        db: mongosDB,
        collName: mongosColl.getName(),
        pipeline: [{$changeStream: {resumeAfter: resumeToken}}],
        expectedCode: 40615
    });

    // However, if we use the resume token to seed a whole-db or cluster-wide change stream rather
    // than a stream on the 'test' collection itself, then we are able to resume successfully. This
    // is because the prohibition on resuming a dropped collection's stream is due to our inability
    // to determine what that collection's default collation was, whereas there are no default
    // collations at the database and cluster levels.
    const wholeDbCursor = mongosDB.watch([], {resumeAfter: resumeToken});
    const wholeClusterCursor = mongosDB.getMongo().watch([], {resumeAfter: resumeToken});

    for (let resumedCursor of[wholeDbCursor, wholeClusterCursor]) {
        print(`Testing resumed stream on ns '${resumedCursor._ns}'`);
        for (let nextId of[-1, 1]) {
            assert.soon(() => resumedCursor.hasNext());
            let next = resumedCursor.next();
            assert.eq(next.operationType, "insert");
            assert.eq(next.fullDocument, {_id: nextId});
            jsTestLog(`Saw insert for _id ${nextId}`);
        }
    }

    st.stop();
}());
