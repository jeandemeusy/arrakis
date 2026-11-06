'use client';

import { type Dispatch, type SetStateAction } from 'react';
import { Plus, Trash2, Wand2 } from 'lucide-react';
import {
  PARAMETER_TYPES,
  type ParameterDefinition,
  type ParameterType,
} from '../api';
import { HelpTip } from '../help-tip';

/** The declared parameters, their defaults, and the values for the next run. */
export function ParametersPanel({
  parameters,
  onChange,
  readOnly,
  missing,
  values,
  onValues,
}: {
  parameters: ParameterDefinition[];
  onChange: (parameters: ParameterDefinition[]) => void;
  readOnly: boolean;
  missing: string[];
  values: Record<string, string>;
  onValues: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  return (
    <section className="parameters" aria-label="Parameters">
      <div className="parameters-head">
        <h3>
          Parameters <HelpTip topic="parameters" />
        </h3>
        {!readOnly && missing.length > 0 && (
          <button
            type="button"
            className="studio-button"
            onClick={() =>
              onChange([
                ...parameters,
                ...missing.map((name) => ({
                  name,
                  type: 'text' as ParameterType,
                })),
              ])
            }
          >
            <Wand2 size={13} aria-hidden="true" /> Declare{' '}
            {missing.map((name) => `{{${name}}}`).join(', ')}
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            className="studio-button"
            onClick={() =>
              onChange([
                ...parameters,
                {
                  name: `param_${parameters.length + 1}`,
                  type: 'text',
                },
              ])
            }
          >
            <Plus size={13} aria-hidden="true" /> Add
          </button>
        )}
      </div>
      {parameters.length === 0 ? (
        <p className="studio-muted">
          None. Write <code>{'{{name}}'}</code> in the SQL to add one.
        </p>
      ) : (
        <table className="parameter-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Default</th>
              <th scope="col">Value for this run</th>
              {!readOnly && (
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {parameters.map((parameter, index) => {
              const change = (patch: Partial<ParameterDefinition>) =>
                onChange(
                  parameters.map((entry, at) =>
                    at === index ? { ...entry, ...patch } : entry,
                  ),
                );
              return (
                <tr key={index}>
                  <td>
                    <input
                      className="studio-input mono"
                      value={parameter.name}
                      disabled={readOnly}
                      aria-label="Parameter name"
                      onChange={(event) => change({ name: event.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="studio-input"
                      value={parameter.type}
                      disabled={readOnly}
                      aria-label="Parameter type"
                      onChange={(event) =>
                        change({
                          type: event.target.value as ParameterType,
                        })
                      }
                    >
                      {PARAMETER_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                    {parameter.type === 'enum' && (
                      <input
                        className="studio-input"
                        placeholder="option, option"
                        value={(parameter.options ?? []).join(', ')}
                        disabled={readOnly}
                        aria-label="Enum options"
                        onChange={(event) =>
                          change({
                            options: event.target.value
                              .split(',')
                              .map((option) => option.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    )}
                  </td>
                  <td>
                    <input
                      className="studio-input"
                      value={
                        parameter.default === undefined ||
                        parameter.default === null
                          ? ''
                          : String(parameter.default as string)
                      }
                      disabled={readOnly}
                      placeholder="none"
                      aria-label="Parameter default"
                      onChange={(event) => {
                        const { default: _, ...rest } = parameter;
                        onChange(
                          parameters.map((entry, at) =>
                            at === index
                              ? event.target.value === ''
                                ? rest
                                : {
                                    ...rest,
                                    default: event.target.value,
                                  }
                              : entry,
                          ),
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="studio-input"
                      value={values[parameter.name] ?? ''}
                      placeholder="default"
                      aria-label={`Value of ${parameter.name}`}
                      onChange={(event) =>
                        onValues((current) => ({
                          ...current,
                          [parameter.name]: event.target.value,
                        }))
                      }
                    />
                  </td>
                  {!readOnly && (
                    <td>
                      <button
                        type="button"
                        className="studio-icon-button"
                        aria-label={`Remove ${parameter.name}`}
                        onClick={() =>
                          onChange(parameters.filter((_, at) => at !== index))
                        }
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
