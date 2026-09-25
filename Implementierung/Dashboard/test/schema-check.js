// schema-check.js — minimal JSON Schema validator for the subset used in Datenmodell/Schema.
'use strict';

// Purely documentary — never interpreted, always allowed.
const STRUCTURAL_KEYWORDS = { '$schema': true, title: true, _note: true, $defs: true, description: true };

// The only keywords this validator actually enforces.
const SUPPORTED_KEYWORDS = {
  type: true, required: true, properties: true, additionalProperties: true,
  items: true, minItems: true, enum: true, minLength: true, minimum: true,
  pattern: true, $ref: true, allOf: true
};

function resolveRef(ref, root) {
  if (ref.indexOf('#/') !== 0) throw new Error('Only local $ref are supported: ' + ref);
  const result = ref.slice(2).split('/').reduce((node, key) => {
    if (node == null) throw new Error('$ref cannot be resolved: ' + ref);
    return node[key];
  }, root);
  if (result == null) throw new Error('$ref cannot be resolved: ' + ref);
  return result;
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

// Validates a value against a schema, returning a list of finding strings.
function validate(value, schema, root, path) {
  const seenSchemas = new WeakSet();
  return check(value, schema, root || schema, path || '');

  function check(value, schema, root, path) {
    let problems = [];
    const at = path || '(root)';

    if (!seenSchemas.has(schema)) {
      seenSchemas.add(schema);
      Object.keys(schema).forEach(key => {
        if (!SUPPORTED_KEYWORDS[key] && !STRUCTURAL_KEYWORDS[key]) {
          problems.push(at + ': schema keyword "' + key + '" is not supported by schema-check.js ' +
            'and has no effect (typo or missing implementation?)');
        }
      });
      const siblings = Object.keys(schema).filter(k => k !== '$ref' && SUPPORTED_KEYWORDS[k]);
      if (schema.$ref && siblings.length) {
        problems.push(at + ': schema keyword(s) ' + siblings.map(k => '"' + k + '"').join(', ') +
          ' next to "$ref" are not evaluated');
      }
    }

    if (schema.$ref) {
      return problems.concat(check(value, resolveRef(schema.$ref, root), root, path));
    }

    if (Array.isArray(schema.allOf)) {
      schema.allOf.forEach(sub => {
        problems = problems.concat(check(value, sub, root, path));
      });
    }

    if (schema.type && !matchesType(value, schema.type)) {
      problems.push(at + ': expected ' + schema.type + ', found ' + typeOf(value));
      return problems;
    }

    if (schema.enum && schema.enum.indexOf(value) === -1) {
      problems.push(at + ': "' + value + '" is not allowed (permitted: ' + schema.enum.join(', ') + ')');
    }

    if (typeof value === 'string') {
      if (schema.minLength != null && value.length < schema.minLength) {
        problems.push(at + (schema.minLength === 1 ? ': must not be empty' : ': needs at least ' + schema.minLength + ' characters'));
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        problems.push(at + ': "' + value + '" does not match the expected format');
      }
    }

    if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) {
      problems.push(at + ': ' + value + ' is smaller than ' + schema.minimum);
    }

    if (typeOf(value) === 'array') {
      if (schema.minItems != null && value.length < schema.minItems) {
        problems.push(at + ': needs at least ' + schema.minItems + ' entry/entries');
      }
      if (schema.items) {
        value.forEach((item, i) => {
          problems = problems.concat(check(item, schema.items, root, path + '[' + i + ']'));
        });
      }
    }

    if (typeOf(value) === 'object') {
      (schema.required || []).forEach(key => {
        if (!(key in value)) problems.push(at + ': required field "' + key + '" is missing');
      });
      const props = schema.properties || {};
      Object.keys(value).forEach(key => {
        const sub = props[key];
        if (sub) {
          problems = problems.concat(check(value[key], sub, root, path ? path + '.' + key : key));
        } else if (schema.additionalProperties === false) {
          problems.push(at + ': unknown field "' + key + '" (typo?)');
        }
      });
    }

    return problems;
  }
}

module.exports = { validate: validate };
