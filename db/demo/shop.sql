-- A small, made-up shop to query: customers, products, orders and their
-- lines, over the year up to the moment it is loaded. Generated from a fixed
-- seed, so a chart drawn from it has the same shape on every machine.
--
-- Loaded by `npm run dev:db -- --demo` into a database of its own, read by a
-- role that can only read, the way any data source should be.

DO $$ BEGIN PERFORM setseed(0.42); END $$;

CREATE TABLE countries (
  code text PRIMARY KEY,
  name text NOT NULL,
  region text NOT NULL
);

INSERT INTO countries (code, name, region) VALUES
  ('CH', 'Switzerland', 'Europe'),
  ('DE', 'Germany', 'Europe'),
  ('FR', 'France', 'Europe'),
  ('IT', 'Italy', 'Europe'),
  ('GB', 'United Kingdom', 'Europe'),
  ('US', 'United States', 'Americas'),
  ('CA', 'Canada', 'Americas'),
  ('BR', 'Brazil', 'Americas'),
  ('JP', 'Japan', 'Asia'),
  ('IN', 'India', 'Asia'),
  ('AU', 'Australia', 'Oceania');

CREATE TABLE products (
  id integer PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price numeric(10, 2) NOT NULL
);

INSERT INTO products (id, name, category, price)
SELECT n,
       initcap(adjective) || ' ' || noun,
       category,
       round((5 + random() * 195)::numeric, 2)
FROM (
  SELECT row_number() OVER () AS n, a.adjective, c.noun, c.category
  FROM unnest(ARRAY['classic', 'compact', 'deluxe', 'everyday', 'trail']) AS a (adjective)
  CROSS JOIN (
    VALUES ('mug', 'Kitchen'), ('kettle', 'Kitchen'), ('backpack', 'Outdoor'),
           ('tent', 'Outdoor'), ('lamp', 'Home'), ('blanket', 'Home'),
           ('notebook', 'Office'), ('pen set', 'Office')
  ) AS c (noun, category)
) AS catalogue;

CREATE TABLE customers (
  id integer PRIMARY KEY,
  name text NOT NULL,
  country text NOT NULL REFERENCES countries (code),
  signed_up_at timestamptz NOT NULL
);

-- More customers sign up as the year goes on; most are in Europe.
INSERT INTO customers (id, name, country, signed_up_at)
SELECT n,
       'Customer ' || n,
       (ARRAY['CH', 'DE', 'DE', 'FR', 'FR', 'IT', 'GB', 'GB', 'US', 'US', 'US',
              'CA', 'BR', 'JP', 'IN', 'AU'])[1 + floor(random() * 16)::int],
       now() - interval '365 days' * (1 - sqrt(random()))
FROM generate_series(1, 1200) AS n;

CREATE TABLE orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  ordered_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('paid', 'shipped', 'delivered', 'refunded'))
);

-- Orders after each customer's sign-up, busier on weekdays and in daytime.
INSERT INTO orders (id, customer_id, ordered_at, status)
SELECT row_number() OVER (ORDER BY placed),
       customer_id,
       placed,
       CASE
         WHEN placed > now() - interval '3 days' THEN 'paid'
         WHEN placed > now() - interval '10 days' THEN 'shipped'
         WHEN random() < 0.04 THEN 'refunded'
         ELSE 'delivered'
       END
FROM (
  SELECT c.id AS customer_id,
         date_trunc('day', c.signed_up_at + (now() - c.signed_up_at) * random())
           + interval '8 hours' + interval '12 hours' * random() AS placed
  FROM customers c
  CROSS JOIN generate_series(1, 6) AS k
  WHERE random() < 0.75
) AS placed_orders
WHERE extract(isodow FROM placed) < 6 OR random() < 0.5;

CREATE TABLE order_items (
  order_id integer NOT NULL REFERENCES orders (id),
  product_id integer NOT NULL REFERENCES products (id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT DISTINCT ON (o.id, p.id)
       o.id, p.id, 1 + floor(random() * 3)::int, p.price
FROM orders o
CROSS JOIN generate_series(1, 3) AS line
-- One product per line, drawn afresh for each (the reference to the row
-- keeps the planner from drawing it once for all).
CROSS JOIN LATERAL (
  SELECT 1 + floor(random() * 40)::int + 0 * o.id + 0 * line AS id
) AS pick
JOIN products p ON p.id = pick.id
WHERE line = 1 OR random() < 0.35;

CREATE INDEX orders_ordered_at ON orders (ordered_at);
CREATE INDEX order_items_product ON order_items (product_id);
ANALYZE;
