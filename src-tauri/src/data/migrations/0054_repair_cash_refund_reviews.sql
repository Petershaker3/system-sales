-- Evidence-backed attribution of one previously uncertain wholly cash payout.
-- This does not change the cancellation or claim mixed/legacy electronic
-- refunds are cash. The reviewer explicitly states the drawer and payout time;
-- database constraints require these to match an actual shift assignment.
CREATE TABLE repair_cash_refund_reviews (
    request_id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(request_id)) BETWEEN 1 AND 120),
    repair_id TEXT NOT NULL UNIQUE REFERENCES uncertain_repair_refunds(repair_id) ON DELETE RESTRICT,
    shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    drawer_id TEXT NOT NULL REFERENCES cash_drawers(id) ON DELETE RESTRICT,
    payout_at INTEGER NOT NULL CHECK(payout_at >= 0),
    evidence TEXT NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 1000),
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at INTEGER NOT NULL CHECK(reviewed_at >= 0),
    CHECK(payout_at <= reviewed_at)
) STRICT;
CREATE TRIGGER repair_cash_refund_reviews_validate BEFORE INSERT ON repair_cash_refund_reviews
BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_id AND role='manager')
   THEN RAISE(ABORT,'cash refund review requires manager') END;
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM uncertain_repair_refunds u
   JOIN repairs r ON r.id=u.repair_id
   JOIN shifts s ON s.id=NEW.shift_id
   JOIN shift_drawers sd ON sd.shift_id=s.id AND sd.drawer_id=NEW.drawer_id
   WHERE u.repair_id=NEW.repair_id AND u.shift_id=NEW.shift_id
     AND r.status='cancelled' AND r.pay_method='cash'
     AND NEW.payout_at>=s.opened_at AND (s.closed_at IS NULL OR NEW.payout_at<=s.closed_at)
     AND u.amount_minor = (SELECT COALESCE(SUM(p.signed_minor),0) FROM cash_source_postings p
        WHERE p.source_id=r.id AND p.source_kind IN ('repair_deposit','repair_delivery'))
     AND NEW.payout_at >= (SELECT MAX(p.occurred_at) FROM cash_source_postings p WHERE p.source_id=r.id AND p.source_kind IN ('repair_deposit','repair_delivery'))
     AND NOT EXISTS (SELECT 1 FROM cash_source_postings p WHERE p.source_kind='repair_cash_refund' AND p.source_id=r.id)
 ) THEN RAISE(ABORT,'cash refund evidence or shift assignment insufficient') END;
END;
CREATE TRIGGER repair_cash_refund_reviews_post AFTER INSERT ON repair_cash_refund_reviews
BEGIN
 INSERT INTO cash_source_postings(source_kind,source_id,shift_id,drawer_id,signed_minor,actor_id,occurred_at)
 SELECT 'repair_cash_refund',u.repair_id,NEW.shift_id,NEW.drawer_id,-u.amount_minor,NEW.actor_id,NEW.payout_at
 FROM uncertain_repair_refunds u WHERE u.repair_id=NEW.repair_id;
END;
CREATE TRIGGER repair_cash_refund_reviews_no_update BEFORE UPDATE ON repair_cash_refund_reviews
BEGIN SELECT RAISE(ABORT,'cash refund reviews are append-only'); END;
CREATE TRIGGER repair_cash_refund_reviews_no_delete BEFORE DELETE ON repair_cash_refund_reviews
BEGIN SELECT RAISE(ABORT,'cash refund reviews are append-only'); END;
