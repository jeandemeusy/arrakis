-- An unsigned big-endian integer of up to 32 bytes — how Blokli stores token
-- amounts — as an exact numeric. Read four bytes at a time, since no integer
-- type holds 256 bits.
--
--   {{> uint256(balance)}}   →   171260453116000000000000
(
  SELECT SUM(
    ('x' || SUBSTRING(LPAD(encode({{$value = '\x0de0b6b3a7640000'::bytea}}, 'hex'), 64, '0') FROM 8 * i + 1 FOR 8))::bit(32)::bigint::numeric
    * (4294967296::numeric ^ (7 - i))
  )
  FROM generate_series(0, 7) AS i
)
