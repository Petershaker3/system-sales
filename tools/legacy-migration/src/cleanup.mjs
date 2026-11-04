// Products that cannot be sold, priced or counted are archived, never deleted.
//
// The legacy catalogue carries placeholder rows the old shop created by accident —
// literally «صنف جديد» — with no price, no cost, no count and no history. They
// cannot be sold (there is no price), they add nothing to the stock value, and in
// «وضع البيع» they are just noise the cashier has to scroll past. Archiving keeps
// them in the database for the record, and the POS lists active products only.

/**
 * @param db an sql.js `Database`, already open.
 * @returns {number} how many rows were archived
 */
export function archiveEmptyProducts(db) {
  const has = (table) => (db.exec(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
  )[0]?.values ?? []).length > 0;
  if (!has('products')) return 0;
  const stock = has('stock_levels')
    ? 'COALESCE((SELECT SUM(quantity) FROM stock_levels s WHERE s.product_id = p.id), 0)'
    : '0';
  const sold = has('sale_lines')
    ? 'COALESCE((SELECT COUNT(*) FROM sale_lines l WHERE l.product_id = p.id), 0)'
    : '0';
  db.run(
    `UPDATE products AS p SET status = 'archived'
      WHERE p.status = 'active'
        AND p.sale_price_minor IS NULL
        AND p.default_cost_minor IS NULL
        AND ${stock} = 0
        AND ${sold} = 0`,
  );
  return db.getRowsModified();
}
