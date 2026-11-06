'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type ParameterDefinition } from '../api';

type FragmentTest = { id: string; name: string; sql: string };
export function FragmentTests({
  slug,
  sql,
  parameters,
  network,
}: {
  slug: string;
  sql: string;
  parameters: ParameterDefinition[];
  network: string;
}) {
  const [tests, setTests] = useState<FragmentTest[]>([]);
  const [name, setName] = useState('');
  const [assertion, setAssertion] = useState(
    `SELECT {{> ${slug}}} IS NOT NULL`,
  );
  const [results, setResults] = useState<
    Record<string, { signature: string; message: string }>
  >({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const path = `/api/v1/queries/${encodeURIComponent(slug)}/tests`;
  useEffect(() => {
    let live = true;
    api<{ tests: FragmentTest[] }>(path)
      .then((data) => {
        if (live) setTests(data.tests);
      })
      .catch((failure: ApiError) => {
        if (live) setError(failure.message);
      });
    return () => {
      live = false;
    };
  }, [path]);
  const add = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { test } = await api<{ test: FragmentTest }>(path, {
        method: 'POST',
        body: { name, sql: assertion },
      });
      setTests((old) => [...old, test]);
      setName('');
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const run = async (test: FragmentTest) => {
    setBusy(true);
    setError('');
    const signature = JSON.stringify([sql, parameters, network, test.sql]);
    try {
      const result = await api<{ passed: boolean; error: string | null }>(
        `${path}/run`,
        { method: 'POST', body: { id: test.id, sql, parameters, network } },
      );
      setResults((old) => ({
        ...old,
        [test.id]: {
          signature,
          message:
            result.error ??
            (result.passed ? 'Passed' : 'Failed: returned false or null'),
        },
      }));
    } catch (failure) {
      setResults((old) => ({
        ...old,
        [test.id]: { signature, message: (failure as ApiError).message },
      }));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (test: FragmentTest) => {
    setBusy(true);
    setError('');
    try {
      await api(`${path}?id=${test.id}`, { method: 'DELETE' });
      setTests((old) => old.filter((entry) => entry.id !== test.id));
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fragment-tests studio-card">
      <h2>Fragment tests</h2>
      <p className="studio-muted">
        Each test is a read-only SQL assertion returning one boolean. Run it
        against the current draft on the selected data source before saving.
      </p>
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      {tests.map((test) => (
        <div key={test.id} className="fragment-test-row">
          <div>
            <strong>{test.name}</strong>
            <pre>{test.sql}</pre>
            {results[test.id] && (
              <output>
                {results[test.id].signature ===
                JSON.stringify([sql, parameters, network, test.sql])
                  ? results[test.id].message
                  : 'Draft or data source changed; run again.'}
              </output>
            )}
          </div>
          <button
            className="studio-button"
            type="button"
            disabled={busy || network === 'all'}
            onClick={() => void run(test)}
          >
            Run test
          </button>
          <button
            className="studio-button"
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete test “${test.name}”?`))
                void remove(test);
            }}
          >
            Delete
          </button>
        </div>
      ))}
      {network === 'all' && (
        <p className="studio-muted">Select one data source to run tests.</p>
      )}
      <details>
        <summary>Add a test</summary>
        <form onSubmit={(event) => void add(event)}>
          <label>
            Test name
            <input
              className="studio-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label>
            SQL assertion
            <textarea
              className="studio-input mono"
              rows={3}
              value={assertion}
              onChange={(event) => setAssertion(event.target.value)}
              required
              maxLength={20000}
            />
          </label>
          <button className="studio-button" disabled={busy}>
            Add test
          </button>
        </form>
      </details>
    </section>
  );
}
