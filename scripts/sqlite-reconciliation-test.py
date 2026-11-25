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
        self.assertEqual(len(paths), 54)
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
            for path in migrations[:-17]:
                prior.executescript(path.read_text(encoding='utf-8'))
            prior.execute("INSERT INTO users(id,display_name,role,verifier,created_at,updated_at) VALUES('u','Fixture','manager','test-only',0,0)")
            prior.execute("INSERT INTO sales(id,reference,occurred_at,sold_by,kind,total_minor,cost_total_minor) VALUES('old','old',100,'u','sale',100,60)")
            before = prior.execute('SELECT * FROM sales').fetchall()
            for path in migrations[-17:]:
                prior.executescript(path.read_text(encoding='utf-8'))
            self.assertEqual(prior.execute('SELECT * FROM sales').fetchall(), before)
            self.assertEqual(prior.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(prior.execute('PRAGMA foreign_key_check').fetchall(), [])
            self.assertTrue(any(row[1] == 'idx_sale_reversals_occurred_at' for row in prior.execute("PRAGMA index_list('sale_reversals')")))
        finally:
            prior.close()

    def test_explicit_refund_links_enforce_source_and_original_capacity(self):
        self.db.execute("INSERT INTO wallets(id,name,pay_method,created_at) VALUES('vf2','Second','vf',0)")
        self.sale('sale', 10, 10000, 5000)
        self.sale('return1', 20, 6000, 3000, 'reversal', 'sale')
        self.sale('return2', 30, 4000, 2000, 'reversal', 'sale')
        self.sale('legacy', 40, 1, 0, 'reversal', 'sale')
        self.db.executemany("INSERT INTO sale_payments(id,sale_id,payment_no,method,wallet_id,amount_minor,occurred_at) VALUES(?,?,?,?,?,?,?)", [
            ('a','sale',1,'vf','vf',3000,10), ('b','sale',2,'vf','vf2',4000,10),
            ('c','sale',3,'cash',None,3000,10),
            ('r1a','return1',1,'vf','vf',3000,20), ('r1b','return1',2,'vf','vf2',3000,20),
            ('r2b','return2',1,'vf','vf2',1000,30), ('r2c','return2',2,'cash',None,3000,30),
            ('old','legacy',1,'cash',None,1,40),
        ])
        for row in [('r1a','a',3000), ('r1b','b',3000), ('r2b','b',1000), ('r2c','c',3000)]:
            self.db.execute('INSERT INTO refund_payment_allocations VALUES(?,?,?)', row)
        self.assertEqual(self.db.execute('SELECT original_payment_id,SUM(amount_minor) FROM refund_payment_allocations GROUP BY original_payment_id ORDER BY original_payment_id').fetchall(), [('a',3000),('b',4000),('c',3000)])
        # Even with the same method, a different wallet is not the source.
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO refund_payment_allocations VALUES('r1b','a',1)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO refund_payment_allocations VALUES('old','c',1)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO refund_payment_allocations VALUES('r1a','a',1)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE refund_payment_allocations SET amount_minor=1")
        # The historical unlinked row remains visible as unknown, not backfilled.
        self.assertEqual(self.db.execute("SELECT p.id FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.kind='reversal' AND s.reverses_sale_id='sale' AND p.amount_minor > COALESCE((SELECT SUM(a.amount_minor) FROM refund_payment_allocations a WHERE a.reversal_payment_id=p.id),0)").fetchall(), [('old',)])

    def test_historical_wallet_review_is_append_only_and_refund_guarded(self):
        self.sale('s', 1, 100, 50)
        self.sale('r', 2, 100, 50, 'reversal', 's')
        self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,wallet_id,amount_minor,occurred_at) VALUES('p','s',1,'vf','vf',100,1)")
        # Simulate a pre-0043 payment, without pretending that its wallet was proven.
        self.db.execute('DROP TRIGGER sale_wallet_provenance_no_delete')
        self.db.execute('DELETE FROM sale_wallet_provenance')
        self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,wallet_id,amount_minor,occurred_at) VALUES('r','r',1,'vf','vf',100,2)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO refund_payment_allocations VALUES('r','p',100)")
        review = "INSERT INTO sale_wallet_reviews(payment_id,wallet_id,action,reason,evidence,actor_id,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)"
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(review, ('p','unknown-wallet','confirm','reason','evidence','u',3,'wrong'))
        self.db.execute(review, ('p','vf','confirm','reason','statement','u',3,'confirm'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(review, ('p','vf','confirm','reason','statement','u',3,'duplicate'))
        self.db.execute(review, ('p','vf','revoke','reason','statement','u',4,'revoke'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO refund_payment_allocations VALUES('r','p',100)")
        self.db.execute(review, ('p','vf','confirm','reason','statement','u',5,'again'))
        self.db.execute("INSERT INTO refund_payment_allocations VALUES('r','p',100)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(review, ('p','vf','revoke','reason','statement','u',6,'used'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM sale_wallet_reviews")
        self.assertEqual(self.db.execute("SELECT wallet_id FROM sale_payments WHERE id='p'").fetchone(), ('vf',))

    def test_cash_posting_captures_known_and_unknown_sources_without_count_postings(self):
        self.sale('before', 1, 100, 0)
        self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,amount_minor,occurred_at) VALUES('unassigned','before',1,'cash',100,1)")
        self.assertEqual(self.db.execute("SELECT drawer_id,signed_minor FROM cash_source_postings WHERE source_id='unassigned'").fetchone(), (None,100))
        self.db.execute("INSERT INTO cash_drawers VALUES('d1','Till','u',2)")
        self.db.execute("INSERT INTO cash_drawer_default VALUES(1,'d1','u',2)")
        self.db.execute("INSERT INTO shifts(id,shift_number,status,opening_cash_minor,opened_by,opened_at) VALUES('shift',1,'open',100,'u',3)")
        self.db.execute("INSERT INTO shift_cash_counts VALUES('count','shift',101,'u',4)")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cash_source_postings").fetchone(), (1,), 'physical count is not a posting')
        self.sale('during', 5, 200, 0)
        self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,amount_minor,occurred_at) VALUES('cash','during',1,'cash',200,5)")
        self.db.execute("INSERT INTO expenses(id,shift_id,paid_from,category,amount_minor,created_by,created_at) VALUES('expense','shift','drawer','tea',20,'u',6)")
        self.db.execute("INSERT INTO expenses(id,shift_id,paid_from,category,amount_minor,created_by,created_at) VALUES('outside',NULL,'outside','tea',99,'u',6)")
        self.assertEqual(self.db.execute("SELECT source_kind,drawer_id,signed_minor FROM cash_source_postings WHERE source_id IN ('cash','expense') ORDER BY source_id").fetchall(), [('sale_payment','d1',200),('expense','d1',-20)])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cash_source_postings WHERE source_id='outside'").fetchone(), (0,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE cash_source_postings SET signed_minor=1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM cash_source_postings")
        self.db.execute("INSERT INTO cash_drawers VALUES('d2','Other','u',7)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE cash_drawer_default SET drawer_id='d2'")
        self.assertEqual(self.db.execute("SELECT drawer_id FROM cash_source_postings WHERE source_id='unassigned'").fetchone(), (None,))

    def test_populated_0048_wallet_upgrade_preserves_existing_cash_and_does_not_backfill(self):
        prior = sqlite3.connect(':memory:')
        try:
            prior.execute('PRAGMA foreign_keys=ON')
            migrations = sorted((ROOT / 'src-tauri/src/data/migrations').glob('[0-9]*.sql'))[:-5]
            for path in migrations[:-1]: prior.executescript(path.read_text(encoding='utf-8'))
            prior.execute("INSERT INTO users(id,display_name,role,verifier,created_at,updated_at) VALUES('u','Fixture','manager','test-only',0,0)")
            prior.execute("INSERT INTO sales(id,reference,occurred_at,sold_by,kind,total_minor,cost_total_minor) VALUES('s','s',1,'u','sale',100,0)")
            prior.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,amount_minor,occurred_at) VALUES('p','s',1,'cash',100,1)")
            prior.execute("INSERT INTO wallet_ops(id,wallet_id,kind,amount_minor,fee_minor,created_by,created_at) VALUES('legacy','vf','deposit',100,10,'u',2)")
            before = prior.execute('SELECT * FROM cash_source_postings').fetchall()
            prior.executescript(migrations[-1].read_text(encoding='utf-8'))
            self.assertEqual(prior.execute('SELECT * FROM cash_source_postings').fetchall(), before)
            self.assertEqual(prior.execute("SELECT COUNT(*) FROM cash_source_postings WHERE source_id='legacy'").fetchone(), (0,))
            self.assertEqual(prior.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(prior.execute('PRAGMA foreign_key_check').fetchall(), [])
        finally:
            prior.close()

    def test_wallet_cash_flows_and_voids_are_event_timed_postings(self):
        self.db.execute("INSERT INTO cash_drawers VALUES('d1','Till','u',1)")
        self.db.execute("INSERT INTO cash_drawer_default VALUES(1,'d1','u',1)")
        self.db.execute("INSERT INTO shifts(id,shift_number,status,opening_cash_minor,opened_by,opened_at) VALUES('s1',1,'open',100,'u',2)")
        self.db.execute("INSERT INTO wallet_ops(id,wallet_id,kind,amount_minor,fee_minor,created_by,created_at) VALUES('dep','vf','deposit',100,10,'u',3)")
        self.db.execute("INSERT INTO wallet_ops(id,wallet_id,kind,amount_minor,fee_minor,created_by,created_at) VALUES('wit','vf','withdraw',200,20,'u',4)")
        self.db.execute("INSERT INTO wallet_ops(id,wallet_id,kind,via,amount_minor,created_by,created_at) VALUES('top','vf','topup','drawer',80,'u',5)")
        self.db.execute("INSERT INTO wallet_ops(id,wallet_id,kind,via,amount_minor,created_by,created_at) VALUES('out','vf','topup','out',30,'u',6)")
        self.db.execute("UPDATE shifts SET status='closed',expected_cash_minor=100,counted_cash_minor=100,difference_minor=0,closed_by='u',closed_at=7 WHERE id='s1'")
        self.db.execute("INSERT INTO cash_drawers VALUES('d2','Next','u',8)")
        self.db.execute("UPDATE cash_drawer_default SET drawer_id='d2',configured_at=8")
        self.db.execute("INSERT INTO shifts(id,shift_number,status,opening_cash_minor,opened_by,opened_at) VALUES('s2',2,'open',100,'u',9)")
        self.db.execute("UPDATE wallet_ops SET voided_by='u',voided_at=10,void_reason='reversed' WHERE id='wit'")
        rows = self.db.execute("SELECT source_kind,source_id,drawer_id,signed_minor,occurred_at FROM cash_source_postings ORDER BY occurred_at").fetchall()
        self.assertEqual(rows, [('wallet_op','dep','d1',110,3),('wallet_op','wit','d1',-180,4),('wallet_op','top','d1',-80,5),('wallet_void','wit','d2',180,10)])
        self.assertEqual(self.db.execute("SELECT SUM(signed_minor) FROM cash_source_postings WHERE occurred_at>=2 AND occurred_at<7").fetchone(),(-150,))
        self.assertEqual(self.db.execute("SELECT SUM(signed_minor) FROM cash_source_postings WHERE occurred_at>=9 AND occurred_at<11").fetchone(),(180,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE wallet_ops SET voided_at=11 WHERE id='wit'")

    def test_repair_cash_refund_review_requires_cash_proof_drawer_and_time(self):
        self.db.execute("INSERT INTO cash_drawers VALUES('a','A','u',1)")
        self.db.execute("INSERT INTO cash_drawers VALUES('b','B','u',1)")
        self.db.execute("INSERT INTO cash_drawer_default VALUES(1,'a','u',1)")
        self.db.execute("INSERT INTO shifts(id,shift_number,status,opening_cash_minor,opened_by,opened_at) VALUES('s',1,'open',0,'u',2)")
        self.db.execute("INSERT INTO repairs(id,ticket_no,device_name,issue,status,deposit_minor,pay_method,created_by,created_at) VALUES('r','r','phone','issue','received',50,'cash','u',3)")
        self.db.execute("UPDATE repairs SET status='cancelled' WHERE id='r'")
        self.db.execute("INSERT INTO uncertain_repair_refunds VALUES('r','s',50,'u',4)")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO repair_cash_refund_reviews VALUES('bad-drawer','r','s','b',4,'evidence','u',5)")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO repair_cash_refund_reviews VALUES('bad-time','r','s','a',2,'evidence','u',5)")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO repair_cash_refund_reviews VALUES('bad-future','r','s','a',6,'evidence','u',5)")
        self.db.execute("INSERT INTO repair_cash_refund_reviews VALUES('ok','r','s','a',4,'receipt 123','u',5)")
        self.assertEqual(self.db.execute("SELECT source_kind,drawer_id,signed_minor,occurred_at FROM cash_source_postings WHERE source_id='r' ORDER BY source_kind").fetchall(), [('repair_cash_refund','a',-50,4),('repair_deposit','a',50,3)])
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO repair_cash_refund_reviews VALUES('dup','r','s','a',4,'evidence','u',5)")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE repair_cash_refund_reviews SET evidence='change'")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("DELETE FROM repair_cash_refund_reviews")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM uncertain_repair_refunds WHERE repair_id='r'").fetchone(),(1,))
        self.db.execute("INSERT INTO repairs(id,ticket_no,device_name,issue,status,created_by,created_at) VALUES('legacy','legacy','phone','issue','cancelled','u',3)")
        self.db.execute("INSERT INTO uncertain_repair_refunds VALUES('legacy','s',50,'u',4)")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO repair_cash_refund_reviews VALUES('unproven','legacy','s','a',4,'evidence','u',5)")
        self.db.execute("INSERT INTO repairs(id,ticket_no,device_name,issue,status,deposit_minor,pay_method,created_by,created_at) VALUES('mixed','mixed','phone','issue','received',50,'cash','u',3)")
        self.db.execute("UPDATE repairs SET status='cancelled',pay_method='vf' WHERE id='mixed'")
        self.db.execute("INSERT INTO uncertain_repair_refunds VALUES('mixed','s',200,'u',4)")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO repair_cash_refund_reviews VALUES('mixed-refund','mixed','s','a',4,'evidence','u',5)")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cash_source_postings WHERE source_id='mixed' AND source_kind='repair_cash_refund'").fetchone(),(0,))

    def test_0054_upgrade_preserves_unresolved_payouts(self):
        db=sqlite3.connect(':memory:'); db.execute('PRAGMA foreign_keys=ON')
        try:
            paths=sorted((ROOT/'src-tauri/src/data/migrations').glob('[0-9]*.sql'))
            for path in paths[:-1]: db.executescript(path.read_text())
            db.execute("INSERT INTO users(id,display_name,role,verifier,created_at,updated_at) VALUES('u','Fixture','manager','test-only',0,0)")
            db.execute("INSERT INTO repairs(id,ticket_no,device_name,issue,status,created_by,created_at) VALUES('r','r','phone','issue','cancelled','u',1)")
            db.execute("INSERT INTO uncertain_repair_refunds VALUES('r',NULL,23,'u',2)")
            before=db.execute('SELECT * FROM uncertain_repair_refunds').fetchall()
            db.executescript(paths[-1].read_text())
            self.assertEqual(db.execute('SELECT * FROM uncertain_repair_refunds').fetchall(),before)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM repair_cash_refund_reviews').fetchone(),(0,))
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone(),('ok',))
        finally: db.close()

    def test_uncertain_repair_refunds_are_explicit_not_cash_postings(self):
        self.db.execute("INSERT INTO repairs(id,ticket_no,device_name,issue,status,created_by,created_at) VALUES('r','r','phone','issue','cancelled','u',1)")
        self.db.execute("INSERT INTO uncertain_repair_refunds VALUES('r',NULL,23,'u',2)")
        self.assertEqual(self.db.execute("SELECT amount_minor,shift_id FROM uncertain_repair_refunds").fetchone(),(23,None))
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE uncertain_repair_refunds SET amount_minor=1")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("DELETE FROM uncertain_repair_refunds")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cash_source_postings").fetchone(),(0,))

    def test_0053_populated_upgrade_does_not_invent_refunds(self):
        db=sqlite3.connect(':memory:'); db.execute('PRAGMA foreign_keys=ON')
        try:
            paths=sorted((ROOT/'src-tauri/src/data/migrations').glob('[0-9]*.sql'))[:-1]
            for path in paths[:-1]: db.executescript(path.read_text())
            db.execute("INSERT INTO users(id,display_name,role,verifier,created_at,updated_at) VALUES('u','Fixture','manager','test-only',0,0)")
            db.execute("INSERT INTO repairs(id,ticket_no,device_name,issue,status,created_by,created_at) VALUES('r','r','phone','issue','cancelled','u',1)")
            before=db.execute('SELECT * FROM repairs').fetchall()
            db.executescript(paths[-1].read_text())
            self.assertEqual(db.execute('SELECT * FROM repairs').fetchall(),before)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM uncertain_repair_refunds').fetchone(),(0,))
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone(),('ok',))
        finally: db.close()

    def test_drawer_physical_counts_are_append_only_and_not_postings(self):
        self.db.execute("INSERT INTO cash_drawers VALUES('a','A','u',1)")
        self.db.execute("INSERT INTO cash_drawer_physical_counts VALUES('c','a',NULL,0,'u',2)")
        self.assertEqual(self.db.execute("SELECT amount_minor,shift_id FROM cash_drawer_physical_counts WHERE request_id='c'").fetchone(),(0,None))
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE cash_drawer_physical_counts SET amount_minor=1 WHERE request_id='c'")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("DELETE FROM cash_drawer_physical_counts WHERE request_id='c'")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO cash_drawer_physical_counts VALUES('bad','a',NULL,-1,'u',2)")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cash_source_postings").fetchone(),(0,))

    def test_0052_upgrade_keeps_populated_drawer_events(self):
        prior=sqlite3.connect(':memory:'); prior.execute('PRAGMA foreign_keys=ON')
        try:
            paths=sorted((ROOT/'src-tauri/src/data/migrations').glob('[0-9]*.sql'))[:-2]
            for path in paths[:-1]: prior.executescript(path.read_text())
            prior.execute("INSERT INTO users(id,display_name,role,verifier,created_at,updated_at) VALUES('u','Fixture','manager','test-only',0,0)")
            prior.execute("INSERT INTO cash_drawers VALUES('a','A','u',1)")
            prior.execute("INSERT INTO cash_drawers VALUES('b','B','u',1)")
            prior.execute("INSERT INTO cash_drawer_default VALUES(1,'a','u',1)")
            prior.execute("INSERT INTO shifts(id,shift_number,status,opening_cash_minor,opened_by,opened_at) VALUES('s',1,'open',0,'u',2)")
            prior.execute("INSERT INTO cash_drawer_transfers VALUES('t','s','a','b',123,'safe','u',3)")
            before=prior.execute('SELECT * FROM cash_source_postings').fetchall()
            prior.executescript(paths[-1].read_text())
            self.assertEqual(prior.execute('SELECT * FROM cash_source_postings').fetchall(),before)
            self.assertEqual(prior.execute('SELECT COUNT(*) FROM cash_drawer_physical_counts').fetchone(),(0,))
            self.assertEqual(prior.execute('PRAGMA foreign_key_check').fetchall(),[])
            self.assertEqual(prior.execute('PRAGMA integrity_check').fetchone(),('ok',))
        finally: prior.close()

    def test_atomic_drawer_transfer_and_constraints(self):
        self.db.execute("INSERT INTO cash_drawers VALUES('a','A','u',1)")
        self.db.execute("INSERT INTO cash_drawers VALUES('b','B','u',1)")
        self.db.execute("INSERT INTO cash_drawer_default VALUES(1,'a','u',1)")
        self.db.execute("INSERT INTO shifts(id,shift_number,status,opening_cash_minor,opened_by,opened_at) VALUES('s',1,'open',0,'u',2)")
        self.db.execute("INSERT INTO cash_drawer_transfers VALUES('t','s','a','b',123,'safe','u',3)")
        self.assertEqual(self.db.execute("SELECT source_kind,drawer_id,signed_minor FROM cash_source_postings WHERE source_id='t' ORDER BY source_kind").fetchall(), [('drawer_transfer_in','b',123),('drawer_transfer_out','a',-123)])
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO cash_drawer_transfers VALUES('t','s','a','b',123,'safe','u',3)")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE cash_drawer_transfers SET amount_minor=1 WHERE request_id='t'")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO cash_drawer_transfers VALUES('bad','s','b','a',1,'bad source','u',4)")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO cash_source_postings VALUES('drawer_transfer_in','fake','s',NULL,5,'u',5)")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO cash_drawer_transfers VALUES('missing','s','a','missing',10,'bad','u',5)")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cash_source_postings WHERE source_id IN ('bad','missing')").fetchone(),(0,))

    def test_transfer_upgrade_preserves_existing_events(self):
        prior=sqlite3.connect(':memory:'); prior.execute('PRAGMA foreign_keys=ON')
        try:
            paths=sorted((ROOT / 'src-tauri/src/data/migrations').glob('[0-9]*.sql'))[:-3]
            for path in paths[:-1]: prior.executescript(path.read_text())
            prior.execute("INSERT INTO users(id,display_name,role,verifier,created_at,updated_at) VALUES('u','Fixture','manager','test-only',0,0)")
            prior.execute("INSERT INTO wallet_ops(id,wallet_id,kind,amount_minor,fee_minor,created_by,created_at) VALUES('op','vf','deposit',10,1,'u',2)")
            before=prior.execute('SELECT * FROM cash_source_postings').fetchall()
            prior.executescript(paths[-1].read_text())
            self.assertEqual(prior.execute('SELECT * FROM cash_source_postings').fetchall(),before)
            self.assertEqual(prior.execute('PRAGMA foreign_key_check').fetchall(),[])
            self.assertEqual(prior.execute('PRAGMA integrity_check').fetchone(),('ok',))
        finally: prior.close()

    def test_populated_0049_upgrade_keeps_postings_without_backfilling_repairs(self):
        prior = sqlite3.connect(':memory:')
        try:
            prior.execute('PRAGMA foreign_keys=ON')
            migrations = sorted((ROOT / 'src-tauri/src/data/migrations').glob('[0-9]*.sql'))[:-4]
            for path in migrations[:-1]: prior.executescript(path.read_text(encoding='utf-8'))
            prior.execute("INSERT INTO users(id,display_name,role,verifier,created_at,updated_at) VALUES('u','Fixture','manager','test-only',0,0)")
            prior.execute("INSERT INTO wallet_ops(id,wallet_id,kind,amount_minor,fee_minor,created_by,created_at) VALUES('op','vf','deposit',10,1,'u',2)")
            prior.execute("INSERT INTO repairs(id,ticket_no,device_name,issue,status,deposit_minor,pay_method,created_by,created_at) VALUES('legacy','legacy','phone','issue','received',20,'cash','u',3)")
            before = prior.execute('SELECT * FROM cash_source_postings').fetchall()
            prior.executescript(migrations[-1].read_text(encoding='utf-8'))
            self.assertEqual(prior.execute('SELECT * FROM cash_source_postings').fetchall(), before)
            self.assertEqual(prior.execute("SELECT COUNT(*) FROM cash_source_postings WHERE source_id='legacy'").fetchone(), (0,))
            self.assertEqual(prior.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(prior.execute('PRAGMA foreign_key_check').fetchall(), [])
        finally:
            prior.close()

    def test_repair_intake_cash_events_do_not_guess_other_methods(self):
        self.db.execute("INSERT INTO cash_drawers VALUES('d','Till','u',1)")
        self.db.execute("INSERT INTO cash_drawer_default VALUES(1,'d','u',1)")
        self.db.execute("INSERT INTO shifts(id,shift_number,status,opening_cash_minor,opened_by,opened_at) VALUES('s',1,'open',0,'u',2)")
        self.db.execute("INSERT INTO repairs(id,ticket_no,device_name,issue,status,deposit_minor,pay_method,created_by,created_at) VALUES('r','r','phone','issue','received',50,'cash','u',3)")
        self.db.execute("INSERT INTO repairs(id,ticket_no,device_name,issue,status,deposit_minor,pay_method,created_by,created_at) VALUES('ambiguous','ambiguous','phone','issue','received',50,'vf','u',4)")
        self.db.execute("INSERT INTO repairs(id,ticket_no,device_name,issue,status,final_price_minor,pay_method,created_by,created_at,delivered_at) VALUES('now','now','phone','issue','delivered',200,'cash','u',5,5)")
        self.assertEqual(self.db.execute("SELECT source_kind,source_id,drawer_id,signed_minor FROM cash_source_postings ORDER BY occurred_at").fetchall(), [('repair_deposit','r','d',50),('repair_delivery','now','d',200)])

    def test_refund_repair_shares_capacity_with_normal_links(self):
        self.sale('s', 1, 1000, 0)
        self.sale('r', 2, 600, 0, 'reversal', 's')
        self.db.executemany("INSERT INTO sale_payments(id,sale_id,payment_no,method,amount_minor,occurred_at) VALUES(?,?,?,?,?,?)", [
            ('a','s',1,'cash',500,1),('b','s',2,'cash',500,1),('refund','r',1,'cash',600,2)])
        self.db.execute("INSERT INTO refund_payment_allocations VALUES('refund','a',100)")
        repair = "INSERT INTO refund_allocation_repairs VALUES(?,?,?,?,?,?,?,?)"
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(repair, ('too-big','refund','a',401,'reason','receipt','u',3))
        self.db.execute(repair, ('one','refund','a',200,'reason','receipt','u',3))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO refund_payment_allocations VALUES('refund','b',301)")
        self.db.execute(repair, ('two','refund','b',300,'reason','receipt','u',4))
        self.assertEqual(self.db.execute("SELECT SUM(amount_minor) FROM refund_allocation_effective WHERE reversal_payment_id='refund'").fetchone(), (600,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(repair, ('three','refund','b',1,'reason','receipt','u',5))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE refund_allocation_repairs SET amount_minor=1")
        self.assertEqual(self.db.execute("SELECT amount_minor FROM sale_payments WHERE id='refund'").fetchone(), (600,))

    def test_reviewed_unknown_source_allows_only_reviewed_wallet_refund(self):
        self.sale('s', 1, 100, 50)
        self.sale('r', 2, 100, 50, 'reversal', 's')
        # Fixture payment predates explicit wallet provenance.
        self.db.execute('DROP TRIGGER sale_wallet_provenance_on_insert')
        self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,wallet_id,amount_minor,occurred_at) VALUES('p','s',1,'vf',NULL,100,1)")
        self.db.execute("INSERT INTO sale_wallet_reviews(payment_id,wallet_id,action,reason,evidence,actor_id,occurred_at,request_id) VALUES('p','ip','confirm','review','statement reference','u',2,'review')")
        self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,wallet_id,amount_minor,occurred_at) VALUES('refund','r',1,'vf','ip',100,2)")
        self.db.execute("INSERT INTO refund_payment_allocations VALUES('refund','p',100)")
        self.assertEqual(self.db.execute("SELECT wallet_id FROM sale_payments WHERE id='p'").fetchone(), (None,))
        self.assertEqual(self.db.execute("SELECT wallet_id FROM sale_effective_wallet_attribution WHERE payment_id='p'").fetchone(), ('ip',))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO sale_wallet_reviews(payment_id,wallet_id,action,reason,evidence,actor_id,occurred_at,request_id) VALUES('p','ip','revoke','reason','evidence','u',3,'revoke')")

    def test_review_cannot_contradict_existing_allocated_refund(self):
        self.sale('s', 1, 100, 50)
        self.sale('r', 2, 100, 50, 'reversal', 's')
        self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,wallet_id,amount_minor,occurred_at) VALUES('p','s',1,'vf','vf',100,1)")
        self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,wallet_id,amount_minor,occurred_at) VALUES('r','r',1,'vf','vf',100,2)")
        self.db.execute("INSERT INTO refund_payment_allocations VALUES('r','p',100)")
        # Fixture simulates an allocation from before the provenance migration.
        self.db.execute('DROP TRIGGER sale_wallet_provenance_no_delete')
        self.db.execute('DELETE FROM sale_wallet_provenance')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO sale_wallet_reviews(payment_id,wallet_id,action,reason,evidence,actor_id,occurred_at,request_id) VALUES('p','ip','confirm','reason','statement','u',3,'conflict')")
        self.db.execute("INSERT INTO sale_wallet_reviews(payment_id,wallet_id,action,reason,evidence,actor_id,occurred_at,request_id) VALUES('p','vf','confirm','reason','statement','u',3,'matched')")
        self.assertEqual(self.db.execute("SELECT wallet_id FROM sale_effective_wallet_attribution WHERE payment_id='p'").fetchone(), ('vf',))

    def test_only_original_reversal_can_use_a_reconfigured_wallet(self):
        self.sale('s', 1, 100, 50)
        self.sale('r', 2, 100, 50, 'reversal', 's')
        self.sale('other', 2, 100, 50)
        self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,wallet_id,amount_minor,occurred_at) VALUES('original','s',1,'vf','vf',100,1)")
        self.db.execute("UPDATE wallets SET pay_method=NULL WHERE id='vf'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,wallet_id,amount_minor,occurred_at) VALUES('new','other',1,'vf','vf',100,2)")
        self.db.execute("INSERT INTO sale_payments(id,sale_id,payment_no,method,wallet_id,amount_minor,occurred_at) VALUES('refund','r',1,'vf','vf',100,2)")
        self.db.execute("INSERT INTO refund_payment_allocations VALUES('refund','original',100)")
        self.assertEqual(self.db.execute("SELECT wallet_id FROM sale_payments WHERE id='refund'").fetchone(), ('vf',))

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
