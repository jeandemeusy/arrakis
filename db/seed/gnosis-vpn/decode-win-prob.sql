-- HOPR's 7-byte winning probability as a number from 0 to 1.
--
-- As hopr-types' WinningProbability::as_f64 does it: read big-endian, add
-- one, and keep the top 52 bits as the mantissa of a float in [1, 2), less
-- one. That is ((v + 1) >> 4) / 2^52 — exact in double precision, and 0 and 1
-- for the all-zero and all-ones encodings.
--
--   {{> decode-win-prob(value)}}   →   0.2
((('x' || encode({{$value = '\xffffffffffffff'::bytea}}, 'hex'))::bit(56)::bigint + 1) >> 4)::float8
  / 4503599627370496
