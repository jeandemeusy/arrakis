-- Bytes as 0x-prefixed hex text, the way addresses are read everywhere.
--
--   {{> hex(account.chain_key)}}   →   '0x6b3c…'
'0x' || encode({{$value = '\x00ff'::bytea}}, 'hex')
