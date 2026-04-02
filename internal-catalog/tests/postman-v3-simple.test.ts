import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { convertAndSplitCollection, type PostmanCollectionV2 } from '../.github/actions/_lib/postman-v3-simple';

describe('postman-v3-simple helper', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        while (tempDirs.length > 0) {
            const dir = tempDirs.pop();
            if (dir) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it('writes a split collection tree with collection, folder, and request yaml files', async () => {
        const tempDir = mkdtempSync(path.join(tmpdir(), 'postman-v3-simple-'));
        tempDirs.push(tempDir);

        const collection: PostmanCollectionV2 = {
            info: {
                name: '[Smoke] Core Payments',
                description: 'Collection description',
                _postman_id: 'collection-id'
            },
            variable: [
                { key: 'baseUrl', value: 'https://api.example.com' }
            ],
            item: [
                {
                    name: 'List Payments',
                    request: {
                        method: 'GET',
                        url: {
                            raw: '{{baseUrl}}/payments?status=active',
                            query: [{ key: 'status', value: 'active' }]
                        }
                    }
                },
                {
                    name: 'Orders',
                    item: [
                        {
                            name: 'Create Order',
                            event: [{
                                listen: 'test',
                                script: {
                                    type: 'text/javascript',
                                    exec: ['pm.test("created", function () {', '  pm.expect(true).to.equal(true);', '});']
                                }
                            }],
                            request: {
                                method: 'POST',
                                url: 'https://api.example.com/orders',
                                header: [{ key: 'Content-Type', value: 'application/json' }],
                                body: {
                                    mode: 'raw',
                                    raw: '{"status":"created"}',
                                    options: { raw: { language: 'json' } }
                                }
                            },
                            response: [{
                                name: 'Created',
                                code: 201,
                                status: 'Created',
                                body: '{"id":"ord_123"}'
                            }]
                        }
                    ]
                }
            ]
        };

        await convertAndSplitCollection(collection, tempDir);

        const collectionYamlPath = path.join(tempDir, 'collection.yaml');
        const listRequestPath = path.join(tempDir, 'List Payments.request.yaml');
        const folderYamlPath = path.join(tempDir, 'Orders', 'folder.yaml');
        const nestedRequestPath = path.join(tempDir, 'Orders', 'Create Order.request.yaml');

        expect(existsSync(collectionYamlPath)).toBe(true);
        expect(existsSync(listRequestPath)).toBe(true);
        expect(existsSync(folderYamlPath)).toBe(true);
        expect(existsSync(nestedRequestPath)).toBe(true);

        const collectionYaml = parse(readFileSync(collectionYamlPath, 'utf8')) as Record<string, any>;
        const folderYaml = parse(readFileSync(folderYamlPath, 'utf8')) as Record<string, any>;
        const nestedRequestYaml = parse(readFileSync(nestedRequestPath, 'utf8')) as Record<string, any>;

        expect(collectionYaml.$schema).toBe('https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/');
        expect(collectionYaml.type).toBe('collection');
        expect(collectionYaml.name).toBe('[Smoke] Core Payments');
        expect(collectionYaml.variables).toEqual([{ key: 'baseUrl', value: 'https://api.example.com' }]);
        expect(collectionYaml.items).toEqual([
            { ref: './List Payments.request.yaml' },
            { ref: './Orders/folder.yaml' }
        ]);

        expect(folderYaml.type).toBe('folder');
        expect(folderYaml.name).toBe('Orders');
        expect(folderYaml.items).toEqual([{ ref: './Create Order.request.yaml' }]);

        expect(nestedRequestYaml.type).toBe('http');
        expect(nestedRequestYaml.name).toBe('Create Order');
        expect(nestedRequestYaml.method).toBe('POST');
        expect(nestedRequestYaml.url).toBe('https://api.example.com/orders');
        expect(nestedRequestYaml.body).toEqual({
            type: 'json',
            content: '{"status":"created"}'
        });
        expect(nestedRequestYaml.examples?.[0]?.response?.statusCode).toBe(201);
        expect(nestedRequestYaml.scripts?.[0]?.type).toBe('afterResponse');
    });
});
