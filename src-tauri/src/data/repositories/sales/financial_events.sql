-- Raw period events, not a profit formula. Timestamps are integer UTC
-- milliseconds; caller supplies [start, end) in the shop's business timezone.
-- Each source is aggregated independently before combining: a sale with several
-- returns must not multiply the original sale. Reversal-shaped sales are not
-- added to sales or separately subtracted: their links identify the event type.
WITH sale_events AS (
    SELECT COUNT(*) AS sale_count,
           COALESCE(SUM(total_minor), 0) AS sale_total_minor,
           COALESCE(SUM(cost_total_minor), 0) AS sale_cost_minor
      FROM sales
     WHERE kind = 'sale' AND occurred_at >= ?1 AND occurred_at < ?2
), return_events AS (
    SELECT COUNT(*) AS return_count,
           COALESCE(SUM(refund_minor), 0) AS refund_minor,
           COALESCE(SUM(cost_returned_minor), 0) AS intact_cost_minor,
           COALESCE(SUM(damaged_cost_minor), 0) AS damaged_cost_minor
      FROM sale_returns
     WHERE occurred_at >= ?1 AND occurred_at < ?2
), cancellation_events AS (
    SELECT COUNT(*) AS cancellation_count,
           COALESCE(SUM(s.total_minor), 0) AS cancelled_total_minor,
           COALESCE(SUM(s.cost_total_minor), 0) AS cancelled_cost_minor,
           COALESCE(SUM(CASE WHEN s.kind <> 'reversal'
                                 OR s.reverses_sale_id IS NOT r.original_sale_id
                                 OR original.kind <> 'sale'
                                 OR s.total_minor <> original.total_minor
                                 OR s.cost_total_minor <> original.cost_total_minor
                             THEN 1 ELSE 0 END), 0) AS inconsistent_cancellation_count
      FROM sale_reversals r
      JOIN sales s ON s.id = r.reversal_sale_id
      JOIN sales original ON original.id = r.original_sale_id
     WHERE r.occurred_at >= ?1 AND r.occurred_at < ?2
)
SELECT * FROM sale_events CROSS JOIN return_events CROSS JOIN cancellation_events;
