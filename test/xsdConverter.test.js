import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { convertXmlWithXsd } from '../lib/xsdConverter.js';

test('converts XML locally using XSD occurrence rules', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-xsd-'));
  const schemaPath = path.join(directory, 'message.xsd');
  fs.writeFileSync(schemaPath, `<?xml version="1.0"?>
    <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
      <xs:element name="billPrint" type="BillPrint"/>
      <xs:complexType name="BillPrint"><xs:sequence>
        <xs:element name="billId" type="xs:string"/>
        <xs:element name="sequence" type="xs:string"/>
        <xs:element name="enabled" type="xs:boolean"/>
        <xs:element name="optional" type="xs:string" minOccurs="0"/>
        <xs:element name="line" maxOccurs="unbounded"><xs:complexType><xs:sequence>
          <xs:element name="amount" type="xs:decimal"/>
        </xs:sequence></xs:complexType></xs:element>
      </xs:sequence></xs:complexType>
    </xs:schema>`);

  const converted = convertXmlWithXsd(
    '<billPrint><billId>002051606115</billId><sequence>1</sequence><enabled>true</enabled><optional></optional><line><amount>12.50</amount></line></billPrint>',
    schemaPath,
  );

  assert.deepEqual(converted, {
    root: {
      billPrint: {
        billId: '002051606115',
        sequence: 1,
        enabled: true,
        line: [{ amount: 12.5 }],
      },
    },
  });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('convertxml uses --xsd without loading an Oracle session', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-xsd-cli-'));
  const schemaPath = path.join(directory, 'message.xsd');
  const xmlPath = path.join(directory, 'message.xml');
  const jsonPath = path.join(directory, 'message.json');
  fs.writeFileSync(schemaPath, '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="billPrint"><xs:complexType><xs:sequence><xs:element name="billId"/></xs:sequence></xs:complexType></xs:element></xs:schema>');
  fs.writeFileSync(xmlPath, '<billPrint><billId>001</billId></billPrint>');

  execFileSync(process.execPath, ['bin/occs.js', 'convertxml', '-i', xmlPath, '-o', jsonPath, '--xsd', schemaPath], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: 'pipe',
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), { billPrint: { billId: '001' } });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('convertxml automatically reroots statement XML to statementPrint', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-statement-xsd-'));
  const schemaPath = path.join(directory, 'statement.xsd');
  const xmlPath = path.join(directory, 'statement.xml');
  const jsonPath = path.join(directory, 'statement.json');
  fs.writeFileSync(schemaPath, '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="CM-StatementPrintRecord"><xs:complexType><xs:sequence><xs:element name="statementPrint"><xs:complexType><xs:sequence><xs:element name="statementDetails"><xs:complexType><xs:sequence><xs:element name="accountId" type="xs:string"/></xs:sequence></xs:complexType></xs:element></xs:sequence></xs:complexType></xs:element></xs:sequence></xs:complexType></xs:element></xs:schema>');
  fs.writeFileSync(xmlPath, '<root><CM-StatementPrintRecord><statementPrint><statementDetails><accountId>123</accountId></statementDetails></statementPrint></CM-StatementPrintRecord></root>');

  execFileSync(process.execPath, ['bin/occs.js', 'convertxml', '-i', xmlPath, '-o', jsonPath, '--xsd', schemaPath], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: 'pipe',
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), {
    statementPrint: { statementDetails: { accountId: '123' } },
  });
  fs.rmSync(directory, { recursive: true, force: true });
});
