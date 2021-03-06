// Tests snapshot isolation on readConcern level snapshot finds through mongos.
//
// @tags: [requires_sharding]
(function() {
    "use strict";

    load("jstests/libs/global_snapshot_reads_util.js");

    const dbName = "test";
    const shardedCollName = "shardedColl";
    const unshardedCollName = "unshardedColl";

    const st = new ShardingTest({shards: 1, mongos: 1, config: 1});

    const shardDb = st.rs0.getPrimary().getDB(dbName);
    if (!shardDb.serverStatus().storageEngine.supportsSnapshotReadConcern) {
        st.stop();
        return;
    }

    assert.commandWorked(st.s.adminCommand({enableSharding: dbName}));
    assert.commandWorked(st.s.adminCommand(
        {shardCollection: st.s.getDB(dbName)[shardedCollName] + "", key: {_id: 1}}));

    function runTest(mainDb, {useCausalConsistency, collName}) {
        const session = mainDb.getMongo().startSession({causalConsistency: useCausalConsistency});
        const sessionDb = session.getDatabase(dbName);

        const bulk = mainDb[collName].initializeUnorderedBulkOp();
        for (let x = 0; x < 10; ++x) {
            bulk.insert({_id: x});
        }
        assert.commandWorked(bulk.execute({w: "majority"}));

        let txnNumber = 0;

        // Test snapshot reads using find.
        let cursorCmd = {
            find: collName,
            sort: {_id: 1},
            batchSize: 5,
            readConcern: {level: "snapshot"},
            txnNumber: NumberLong(txnNumber)
        };

        // Establish a snapshot cursor, fetching the first 5 documents.

        let res = assert.commandWorked(sessionDb.runCommand(cursorCmd));

        assert(res.hasOwnProperty("cursor"));
        assert(res.cursor.hasOwnProperty("firstBatch"));
        assert.eq(5, res.cursor.firstBatch.length);

        assert(res.cursor.hasOwnProperty("id"));
        const cursorId = res.cursor.id;
        assert.neq(cursorId, 0);

        // Insert an 11th document which should not be visible to the snapshot cursor. This write is
        // performed outside of the session.
        assert.writeOK(mainDb[collName].insert({_id: 10}, {writeConcern: {w: "majority"}}));

        verifyInvalidGetMoreAttempts(mainDb, sessionDb, collName, cursorId, txnNumber);

        // Fetch the 6th document. This confirms that the transaction stash is preserved across
        // multiple getMore invocations.
        res = assert.commandWorked(sessionDb.runCommand({
            getMore: cursorId,
            collection: collName,
            batchSize: 1,
            txnNumber: NumberLong(txnNumber)
        }));
        assert(res.hasOwnProperty("cursor"));
        assert(res.cursor.hasOwnProperty("id"));
        assert.neq(0, res.cursor.id);

        // Exhaust the cursor, retrieving the remainder of the result set.
        res = assert.commandWorked(sessionDb.runCommand({
            getMore: cursorId,
            collection: collName,
            batchSize: 10,
            txnNumber: NumberLong(txnNumber)
        }));

        // The cursor has been exhausted.
        assert(res.hasOwnProperty("cursor"));
        assert(res.cursor.hasOwnProperty("id"));
        assert.eq(0, res.cursor.id);

        // Only the remaining 4 of the initial 10 documents are returned. The 11th document is not
        // part of the result set.
        assert(res.cursor.hasOwnProperty("nextBatch"));
        assert.eq(4, res.cursor.nextBatch.length);

        // Perform a second snapshot read under a new transaction.
        txnNumber++;
        res = assert.commandWorked(sessionDb.runCommand({
            find: collName,
            sort: {_id: 1},
            batchSize: 20,
            readConcern: {level: "snapshot"},
            txnNumber: NumberLong(txnNumber)
        }));

        // The cursor has been exhausted.
        assert(res.hasOwnProperty("cursor"));
        assert(res.cursor.hasOwnProperty("id"));
        assert.eq(0, res.cursor.id);

        // All 11 documents are returned.
        assert(res.cursor.hasOwnProperty("firstBatch"));
        assert.eq(11, res.cursor.firstBatch.length);

        session.endSession();
    }

    jsTestLog("Running sharded");
    runTest(st.s.getDB(dbName), {useCausalConsistency: false, collName: shardedCollName});
    jsTestLog("Running unsharded");
    runTest(st.s.getDB(dbName), {useCausalConsistency: false, collName: unshardedCollName});

    st.stop();
})();
