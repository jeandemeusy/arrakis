SELECT balance
FROM hopr_balance
WHERE address IN (SELECT address FROM hopr_safe_contract);
