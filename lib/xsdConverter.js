import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

const DOM_PARSER = new (new JSDOM('').window.DOMParser)();
// Oracle's converter serializes these billing value fields as numbers even in
// schema revisions that declare them as xsd:string. Keep this narrow so IDs,
// account numbers, and other string identifiers retain their exact values.
const ORACLE_NUMERIC_STRING_FIELDS = new Set(['sequence', 'days', 'calcAmt']);

function localName(node) {
  return node?.localName || String(node?.nodeName || '').split(':').pop();
}

function childElements(node, name) {
  return [...(node?.children || [])].filter((child) => !name || localName(child) === name);
}

function qualifiedLocalName(name) {
  return String(name || '').split(':').pop();
}

function parseSchemaDocument(schemaPath) {
  const source = fs.readFileSync(schemaPath, 'utf8');
  const document = DOM_PARSER.parseFromString(source, 'application/xml');
  const error = document.querySelector('parsererror');
  if (error) {
    throw new Error(`XSD is not well-formed: ${String(error.textContent || '').replace(/\s+/g, ' ').trim()}`);
  }
  const schema = document.documentElement;
  if (localName(schema) !== 'schema') {
    throw new Error('XSD reference must point to an xs:schema document.');
  }
  return schema;
}

function collectSchemaNodes(schemaPath, visited = new Set(), nodes = []) {
  const canonicalPath = path.resolve(schemaPath);
  if (visited.has(canonicalPath)) return nodes;
  if (!fs.existsSync(canonicalPath)) throw new Error(`XSD reference not found: ${canonicalPath}`);
  visited.add(canonicalPath);

  const schema = parseSchemaDocument(canonicalPath);
  nodes.push({ schema, schemaPath: canonicalPath });

  for (const child of childElements(schema)) {
    if (!['include', 'import', 'redefine'].includes(localName(child))) continue;
    const location = child.getAttribute('schemaLocation');
    if (!location) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(location)) {
      throw new Error(`Remote XSD references are not supported: ${location}`);
    }
    collectSchemaNodes(path.resolve(path.dirname(canonicalPath), location), visited, nodes);
  }
  return nodes;
}

function buildSchemaIndex(schemaPath) {
  const schemas = collectSchemaNodes(schemaPath);
  const elements = new Map();
  const declarations = new Map();
  const types = new Map();
  for (const { schema } of schemas) {
    for (const child of childElements(schema)) {
      const name = child.getAttribute('name');
      if (!name) continue;
      if (localName(child) === 'element') elements.set(name, child);
      if (localName(child) === 'complexType' || localName(child) === 'simpleType') types.set(name, child);
    }
    for (const element of [...schema.getElementsByTagName('*')].filter((node) => localName(node) === 'element')) {
      const name = element.getAttribute('name') || qualifiedLocalName(element.getAttribute('ref'));
      if (name && !declarations.has(name)) declarations.set(name, element);
    }
  }
  return { elements, declarations, types };
}

function declarationForElement(node, index) {
  const ref = node.getAttribute('ref');
  if (ref) return index.elements.get(qualifiedLocalName(ref)) || node;
  return node;
}

function typeForDeclaration(declaration, index) {
  const inline = childElements(declaration).find((child) => ['complexType', 'simpleType'].includes(localName(child)));
  if (inline) return inline;
  const type = declaration.getAttribute('type');
  return type ? index.types.get(qualifiedLocalName(type)) || null : null;
}

function particleElements(node) {
  const found = [];
  const visit = (current) => {
    for (const child of childElements(current)) {
      const kind = localName(child);
      if (kind === 'element') found.push(child);
      else if (['sequence', 'choice', 'all', 'group', 'complexContent', 'simpleContent', 'extension', 'restriction'].includes(kind)) visit(child);
    }
  };
  visit(node);
  return found;
}

function childDeclarations(declaration, index) {
  const type = typeForDeclaration(declaration, index);
  if (!type || localName(type) !== 'complexType') return new Map();
  const declarations = new Map();
  for (const node of particleElements(type)) {
    const resolved = declarationForElement(node, index);
    const name = resolved.getAttribute('name') || qualifiedLocalName(node.getAttribute('ref'));
    if (name) declarations.set(name, { node, resolved });
  }
  return declarations;
}

function isRepeating(declarationNode) {
  const maxOccurs = declarationNode?.getAttribute('maxOccurs');
  return maxOccurs === 'unbounded' || (maxOccurs !== null && Number(maxOccurs) > 1);
}

function xmlElementChildren(node) {
  return [...node.children];
}

function attributesFor(node) {
  const values = {};
  for (const attribute of [...node.attributes]) {
    if (!attribute.name.startsWith('xmlns')) values[qualifiedLocalName(attribute.name)] = attribute.value;
  }
  return values;
}

function simpleTypeName(declaration, index) {
  const type = typeForDeclaration(declaration, index);
  if (!type) return qualifiedLocalName(declaration?.getAttribute('type'));
  if (localName(type) === 'simpleType') {
    const restriction = childElements(type).find((child) => localName(child) === 'restriction');
    return qualifiedLocalName(restriction?.getAttribute('base'));
  }
  const simpleContent = childElements(type).find((child) => localName(child) === 'simpleContent');
  const extension = childElements(simpleContent).find((child) => ['extension', 'restriction'].includes(localName(child)));
  return qualifiedLocalName(extension?.getAttribute('base'));
}

function convertScalar(value, declaration, index, elementName) {
  if (value === '') return value;
  const type = simpleTypeName(declaration, index);
  if (type === 'boolean') return value === 'true' || value === '1';
  const numericType = ['decimal', 'float', 'double', 'integer', 'int', 'long', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger', 'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte'].includes(type);
  if (numericType || (type === 'string' && ORACLE_NUMERIC_STRING_FIELDS.has(elementName))) {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  return value;
}

function convertElement(xmlNode, declaration, index) {
  const children = xmlElementChildren(xmlNode);
  const attributes = attributesFor(xmlNode);
  if (children.length === 0) {
    const value = convertScalar(xmlNode.textContent || '', declaration, index, qualifiedLocalName(xmlNode.nodeName));
    return Object.keys(attributes).length ? { '@attributes': attributes, '#text': value } : value;
  }

  const declaredChildren = declaration ? childDeclarations(declaration, index) : new Map();
  const grouped = new Map();
  for (const child of children) {
    const name = qualifiedLocalName(child.nodeName);
    const group = grouped.get(name) || [];
    group.push(child);
    grouped.set(name, group);
  }

  const output = Object.keys(attributes).length ? { '@attributes': attributes } : {};
  for (const [name, matches] of grouped) {
    const definition = declaredChildren.get(name);
    // Once a schema complex type is known, mirror the Oracle converter by
    // omitting XML fields that are not part of that type.
    if (!definition && declaredChildren.size > 0) continue;
    const values = matches.map((child) => convertElement(child, definition?.resolved || index.elements.get(name), index));
    // CCS's converter omits empty optional elements rather than emitting an
    // empty string. Keep empty values only when they carry an XML attribute.
    const nonEmptyValues = values.filter((value) => value !== '');
    if (nonEmptyValues.length === 0) continue;
    output[name] = isRepeating(definition?.node) || values.length > 1 ? nonEmptyValues : nonEmptyValues[0];
  }
  const directText = [...xmlNode.childNodes]
    .filter((child) => child.nodeType === 3 || child.nodeType === 4)
    .map((child) => child.textContent)
    .join('')
    .trim();
  if (directText) output['#text'] = directText;
  return output;
}

/**
 * Convert XML using local XSD structure. XSD controls which singleton elements
 * remain arrays (via maxOccurs). XML Schema numeric and boolean types become
 * JSON primitives, while schema strings preserve IDs and leading zeroes.
 */
export function convertXmlWithXsd(xmlSource, xsdReference) {
  const xsdPath = path.resolve(String(xsdReference || ''));
  if (!xsdReference) throw new Error('An XSD reference is required for local XML conversion.');
  const index = buildSchemaIndex(xsdPath);
  const document = DOM_PARSER.parseFromString(String(xmlSource || ''), 'application/xml');
  const error = document.querySelector('parsererror');
  if (error) throw new Error(`XML is not well-formed: ${String(error.textContent || '').replace(/\s+/g, ' ').trim()}`);
  const root = document.documentElement;
  const rootName = qualifiedLocalName(root.nodeName);
  return { root: { [rootName]: convertElement(root, index.elements.get(rootName) || index.declarations.get(rootName), index) } };
}
