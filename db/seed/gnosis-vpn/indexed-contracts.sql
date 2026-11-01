-- The contracts this index subscribes to, named by the events they emit.
--
-- Blokli records one row per (contract, event topic) it watches, so the
-- distinct addresses are the contracts indexed and the topics — 32-byte event
-- signature hashes — say what each one is.
WITH role (topic, name) AS (
  VALUES
    ('ed22f34d154d253a7f6fd477439be59080a1554aa0d0642686d64223ab544c8a', 'Channels'),
    ('004c0177ad15bb302b4419e9ac96065d6f436e0f61972f97bbe272834c40f934', 'Channels'),
    ('197bba684a6afb7ba24f1d265605414b1d0051a6e295d6ff7b6e78e870d7a7f0', 'Channels'),
    ('c4df5ba16814838ab2618829d68f8623bb897302f24dbdba2279dbe45adb3d14', 'Announcements'),
    ('11d94653de52fc143887956fe4b5e4120a850b1300ece0533dee6bd8ff91f732', 'Announcements'),
    ('a4de30a528becadf82649d1395c0e30dd18ae35b5a96ce71e9295bb14bc9f3bc', 'Announcements'),
    ('776da40cbf2c223552661bd48502ceb72409b3362bb0c66d8989bd7e20e4497d', 'Node safe registry'),
    ('1eb3e9b31552ebe06015df6569e31abbec0e73a88c3ccdd9fead65c4378b4e50', 'Node safe registry'),
    ('2c906e9f9056ce9dab322be95fe710c2ecfa369bf6bf530bc81ced25caee90e1', 'Service registry'),
    ('38a84f1ca3cac973fcc30eeaccfd5a063993a9bd564530c4790ef60291c6b161', 'Service registry'),
    ('d4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fb', 'Ticket price oracle'),
    ('02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3800', 'Winning probability oracle'),
    ('06b541ddaa720db2b10a4d0cdac39b8d360425fc073085fac19bc82614677987', 'wxHOPR token'),
    ('f4caeb2d6ca8932a215a353d0703c326ec2d81fc68170f320eb2ab49e9df61f9', 'wxHOPR token'),
    ('83a5c31bfee49d254d95e3946d8e8434e5975382fa8b849182db9e251aaaaa26', 'Node stake factory'),
    ('141df868a6331af528e38c83b7aa03edc19be66e37ae67f9285bf4f8e3c6a1a8', 'Safe'),
    ('442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e', 'Safe')
),
contract AS (
  SELECT address, ARRAY_AGG(DISTINCT encode(topic, 'hex') ORDER BY encode(topic, 'hex')) AS topics
  FROM log_topic_info
  GROUP BY address
)
SELECT
  COALESCE(
    (
      SELECT role.name
      FROM unnest(contract.topics) WITH ORDINALITY AS t (topic, position)
      JOIN role ON role.topic = t.topic
      ORDER BY t.position
      LIMIT 1
    ),
    'Indexed contract'
  ) AS role,
  {{> hex(contract.address)}} AS contract
FROM contract
ORDER BY role, contract
