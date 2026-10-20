-- Default instruments. Product symbols and spreads are admin-editable afterwards.
INSERT INTO instruments (code, display_name, underlying, product_symbol, price_unit_label, unit_grams,
                         qty_unit, qty_step, qty_min, qty_max, fallback_spread_paise, brokerage_paise,
                         tick_size_paise, sort_order)
VALUES
  ('GOLD', 'Gold', 'GOLD', 'GOLDM', '₹ per 10 g', 10, 'g', 1, 1, 10000, 300, 0, 100, 1),
  ('SILVER', 'Silver', 'SILVER', 'SILVERM', '₹ per kg', 1000, 'g', 100, 100, 100000, 2000, 0, 100, 2)
ON CONFLICT (code) DO NOTHING;
