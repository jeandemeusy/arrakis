-- Where an item came from: the bundle that created it, so importing a newer
-- version of the same bundle updates it, and importing another bundle that
-- happens to use the same slug does not overwrite it unannounced.
ALTER TABLE queries ADD COLUMN bundle text;
ALTER TABLE dashboards ADD COLUMN bundle text;
ALTER TABLE visualizations ADD COLUMN bundle text;

-- Before bundles could be imported, one shipped built in and was installed by
-- the arrakis-installer account. What it created is marked as coming from it,
-- so importing its file now updates that install rather than conflicting.
UPDATE queries SET bundle = 'gnosis-vpn'
WHERE official AND created_by = (SELECT id FROM users WHERE username = 'arrakis-installer');
UPDATE dashboards SET bundle = 'gnosis-vpn'
WHERE official AND created_by = (SELECT id FROM users WHERE username = 'arrakis-installer');
UPDATE visualizations SET bundle = 'gnosis-vpn'
WHERE seed_key IS NOT NULL;
