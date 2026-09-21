/**
 * Minimal JSON Schema checker for the shapes the tool catalogs declare:
 * `object` (properties / required / additionalProperties), `string`
 * (minLength / maxLength / enum), `integer` / `number` (minimum / maximum),
 * `boolean`, `array` (items / minItems / maxItems). Anything else passes.
 *
 * Pure and dependency-free so it can move to `@plannotator/core` untouched.
 * Returns the first problem as one sentence for the model, or `null`.
 */

export type JsonSchema = Record<string, unknown>;

export function validateAgainstSchema(schema: JsonSchema | undefined, value: unknown, path = 'input'): string | null {
  if (!schema) return null;
  const type = schema.type;
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((v) => v === value)) {
    return `${path} must be one of ${enumValues.map((v) => JSON.stringify(v)).join(', ')}`;
  }
  switch (type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
      const record = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      for (const key of required) {
        if (record[key] === undefined) return `${path}.${key} is required`;
      }
      for (const [key, child] of Object.entries(record)) {
        const childSchema = properties[key];
        if (!childSchema) {
          if (schema.additionalProperties === false) return `${path}.${key} is not a known field`;
          continue;
        }
        if (child === undefined) continue;
        const problem = validateAgainstSchema(childSchema, child, `${path}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return `${path} must be a string`;
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
        return `${path} must be at least ${schema.minLength} characters`;
      }
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
        return `${path} must be at most ${schema.maxLength} characters`;
      }
      return null;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number`;
      if (type === 'integer' && !Number.isInteger(value)) return `${path} must be an integer`;
      if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
      if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be a boolean`;
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
        return `${path} must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`;
      }
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
        return `${path} must have at most ${schema.maxItems} items`;
      }
      const items = schema.items as JsonSchema | undefined;
      if (items) {
        for (let i = 0; i < value.length; i++) {
          const problem = validateAgainstSchema(items, value[i], `${path}[${i}]`);
          if (problem) return problem;
        }
      }
      return null;
    }
    default:
      return null;
  }
}
