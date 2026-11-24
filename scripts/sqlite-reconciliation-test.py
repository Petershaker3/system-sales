#!/usr/bin/env python3
"""Schema/ledger experiment using real migrations and synthetic data only.

Executes the same raw event aggregation SQL as the Rust repository using
Python SQLite. This is not a SQLx test or an approved profit formula.
"""
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]


class LedgerReconciliation(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        paths = sorted((ROOT / 'src-tauri/src/data/migrations').glob('[0-9]*.sql'))
        self.assertEqual(len(paths), 38)
        for path in paths:
            self.db.executescript(path.read_text(encoding='utf-8'))
        self.db.execute("INSERT INTO users(id,display_name,role,verifier,created_at,updated_at) VALUES('u','Fixture','manager','test-only',0,0)")

    def tearDown(self):
        self.db.close()

    def sale(self, id, timestamp, total, cost, kind='sale', reverses=None):
        self.db.execute('INSERT INTO sales(id,reference,occurred_at,sold_by,kind,reverses_sale_id,total_minor,cost_total_minor) VALUES(?,?,?,?,?,?,?,?)',
                        (id, id, timestamp, 'u', kind, reverses, total, cost))

    def test_all_migrations_integrity_and_backup_copy(self):
        self.assertEqual(self.db.execute('PRAGMA integrity_check').fetchone(), ('ok',))
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.sale('a', 1, 100, 60)
        restored = sqlite3.connect(':memory:')
        try:
            self.db.commit()
            self.db.backup(restored)
            self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(restored.execute('SELECT total_minor,cost_total_minor FROM sales WHERE id=?', ('a',)).fetchone(), (100, 60))
        finally:
            restored.close()

    def test_populated_previous_schema_accepts_additive_index(self):
        prior = sqlite3.connect(':memory:')
        try:
            prior.execute('PRAGMA foreign_keys=ON')
            migrations = sorted((ROOT / 'src-tauri/src/data/migrations').glob('[0-9]*.sql'))
            for path in migrations[:-1]:
                prior.executescript(path.read_text(encoding='utf-8'))
            prior.execute("INSERT INTO users(id,display_name,role,verifier,created_at,updated_at) VALUES('u','Fixture','manager','test-only',0,0)")
            prior.execute("INSERT INTO sales(id,reference,occurred_at,sold_by,kind,total_minor,cost_total_minor) VALUES('old','old',100,'u','sale',100,60)")
            before = prior.execute('SELECT * FROM sales').fetchall()
            prior.executescript(migrations[-1].read_text(encoding='utf-8'))
            self.assertEqual(prior.execute('SELECT * FROM sales').fetchall(), before)
            self.assertEqual(prior.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(prior.execute('PRAGMA foreign_key_check').fetchall(), [])
            self.assertTrue(any(row[1] == 'idx_sale_reversals_occurred_at' for row in prior.execute("PRAGMA index_list('sale_reversals')")))
        finally:
            prior.close()

    def test_ledger_event_totals_do_not_multiply_split_returns_or_hide_zero_refunds(self):
        # 5002 sale documents plus a later exchange sale. Both refunds refer to
        # the same original sale: joining sales directly to returns would repeat
        # its revenue. A zero-value return is still an event.
        for i in range(5002):
            self.sale(f's{i}', 100, 10000, 6000)
        self.sale('r1', 200, 1000, 600, 'reversal', 's0')
        self.sale('r2', 200, 0, 0, 'reversal', 's0')
        self.sale('exchange', 200, 3000, 2000)
        self.sale('full-return', 200, 10000, 6000, 'reversal', 's2')
        self.sale('damage-return', 200, 10000, 0, 'reversal', 's3')
        self.sale('cancel-reversal', 200, 10000, 6000, 'reversal', 's1')
        self.db.execute("INSERT INTO sale_returns(id,original_sale_id,return_sale_id,exchange_sale_id,refund_minor,cost_returned_minor,damaged_cost_minor,reason,actor_id,approved_by,occurred_at) VALUES('ret1','s0','r1','exchange',1000,600,0,'fixture','u','u',200)")
        self.db.execute("INSERT INTO sale_returns(id,original_sale_id,return_sale_id,refund_minor,cost_returned_minor,damaged_cost_minor,reason,actor_id,approved_by,occurred_at) VALUES('ret2','s0','r2',0,0,0,'fixture','u','u',200)")
        self.db.execute("INSERT INTO sale_reversals(id,original_sale_id,reversal_sale_id,occurred_at,actor_id,reason) VALUES('cancel','s1','cancel-reversal',200,'u','fixture')")
        self.db.execute("INSERT INTO sale_returns(id,original_sale_id,return_sale_id,refund_minor,cost_returned_minor,damaged_cost_minor,reason,actor_id,approved_by,occurred_at) VALUES('ret3','s2','full-return',10000,6000,0,'fixture','u','u',200)")
        self.db.execute("INSERT INTO sale_returns(id,original_sale_id,return_sale_id,refund_minor,cost_returned_minor,damaged_cost_minor,reason,actor_id,approved_by,occurred_at) VALUES('ret4','s3','damage-return',10000,0,6000,'fixture','u','u',200)")
        self.db.executemany("INSERT INTO sale_payments(id,sale_id,payment_no,method,amount_minor,occurred_at,wallet_id) VALUES(?,?,?,?,?,?,?)", [
            ('p1','s0',1,'cash',4000,100,None), ('p2','s0',2,'vf',6000,100,'vf'),
            ('p3','r1',1,'cash',400,200,None), ('p4','r1',2,'vf',600,200,'vf'),
        ])
        self.assertEqual(self.db.execute("SELECT method,wallet_id,amount_minor FROM sale_payments WHERE sale_id='r1' ORDER BY payment_no").fetchall(), [('cash', None, 400), ('vf', 'vf', 600)])
        # Link uniqueness enforces a repeated cancellation and the same return
        # document cannot be attached twice, regardless of the amount.
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO sale_reversals(id,original_sale_id,reversal_sale_id,occurred_at,actor_id,reason) VALUES('duplicate','s1','cancel-reversal',201,'u','again')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO sale_returns(id,original_sale_id,return_sale_id,refund_minor,cost_returned_minor,reason,actor_id,approved_by,occurred_at) VALUES('duplicate','s0','r2',0,0,'again','u','u',201)")
        count, gross, cost = self.db.execute("SELECT COUNT(*), SUM(total_minor), SUM(cost_total_minor) FROM sales WHERE kind='sale' AND occurred_at >= ? AND occurred_at < ?", (0, 150)).fetchone()
        self.assertEqual((count, gross, cost), (5002, 50020000, 30012000))
        # Return events and cancellation events are distinct; don't subtract
        # reversal-shaped sales a second time. Report policy still needs review.
        self.assertEqual(self.db.execute('SELECT COUNT(*), SUM(refund_minor), SUM(cost_returned_minor), SUM(damaged_cost_minor) FROM sale_returns WHERE occurred_at >= ? AND occurred_at < ?', (150, 250)).fetchone(), (4, 21000, 6600, 6000))
        self.assertEqual(self.db.execute('SELECT COUNT(*), SUM(s.total_minor), SUM(s.cost_total_minor) FROM sale_reversals r JOIN sales s ON s.id=r.original_sale_id WHERE r.occurred_at >= ? AND r.occurred_at < ?', (150, 250)).fetchone(), (1, 10000, 6000))
        self.assertEqual(self.db.execute("SELECT (SELECT COUNT(*) FROM sale_returns sr WHERE sr.original_sale_id=s.id), COALESCE((SELECT SUM(sr.refund_minor) FROM sale_returns sr WHERE sr.original_sale_id=s.id),0) FROM sales s WHERE s.id='s0'").fetchone(), (2, 1000))
        # The exact SQL consumed by the production repository, not a retyped
        # approximation. Components stay separate; no profit assertion is made.
        query = (ROOT / 'src-tauri/src/data/repositories/sales/financial_events.sql').read_text(encoding='utf-8')
        self.assertEqual(self.db.execute(query, (0, 150)).fetchone(), (5002, 50020000, 30012000, 0, 0, 0, 0, 0, 0, 0, 0))
        self.assertEqual(self.db.execute(query, (150, 250)).fetchone(), (1, 3000, 2000, 4, 21000, 6600, 6000, 1, 10000, 6000, 0))
        self.assertEqual(self.db.execute(query, (0, 250)).fetchone(), (5003, 50023000, 30014000, 4, 21000, 6600, 6000, 1, 10000, 6000, 0))
        plan = self.db.execute('EXPLAIN QUERY PLAN ' + query, (150, 250)).fetchall()
        for index in ('idx_sales_occurred_at', 'idx_sale_returns_occurred_at', 'idx_sale_reversals_occurred_at'):
            self.assertTrue(any(index in row[3] for row in plan), (index, plan))
        plan = self.db.execute("EXPLAIN QUERY PLAN SELECT SUM(total_minor) FROM sales WHERE occurred_at >= ? AND occurred_at < ? AND kind='sale'", (0, 150)).fetchall()
        self.assertTrue(any('idx_sales_occurred_at' in row[3] for row in plan), plan)
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])


if __name__ == '__main__':
    unittest.main()
