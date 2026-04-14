import { fetchGraphs, fetchServiceDetail, getFernDocsUrl, getRunInPostmanUrl, getEntrypointUrl, formatRuntime } from '../api';

describe('api', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchGraphs', () => {
    it('fetches graphs successfully', async () => {
      const mockData = { graphs: [], standalone: [] };
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => mockData,
      } as Response);

      const result = await fetchGraphs();
      expect(result).toEqual(mockData);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/partner/graphs?env=prod');
    });

    it('throws error on failed request', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      await expect(fetchGraphs()).rejects.toThrow('Request failed: 500');
    });
  });

  describe('fetchServiceDetail', () => {
    it('fetches service detail successfully', async () => {
      const mockData = { service_id: 's1' };
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => mockData,
      } as Response);

      const result = await fetchServiceDetail('s1');
      expect(result).toEqual(mockData);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/partner/services/s1');
    });
  });

  describe('url helpers', () => {
    it('getFernDocsUrl returns correct url', () => {
      expect(getFernDocsUrl({ service_id: 's1', fern_docs_url: 'https://custom.docs' })).toBe('https://custom.docs');
      expect(getFernDocsUrl({ service_id: 's1', fernDocsUrl: 'https://custom.docs2' })).toBe('https://custom.docs2');
      expect(getFernDocsUrl({ service_id: 's1' })).toBe('https://vzw-demo.docs.buildwithfern.com');
    });

    it('getRunInPostmanUrl returns correct url', () => {
      expect(getRunInPostmanUrl({ service_id: 's1', run_in_postman_url: 'https://custom.postman' })).toBe('https://custom.postman');
      expect(getRunInPostmanUrl({ service_id: 's1', runInPostmanUrl: 'https://custom.postman2' })).toBe('https://custom.postman2');
      expect(getRunInPostmanUrl({ service_id: 's1' })).toBe('https://app.getpostman.com/workspace/s1');
    });

    it('getEntrypointUrl returns correct url', () => {
      expect(getEntrypointUrl({ entrypoint_url: 'https://api.test' })).toBe('https://api.test');
      expect(getEntrypointUrl({ entrypointUrl: 'https://api.test2' })).toBe('https://api.test2');
      expect(getEntrypointUrl({})).toBeNull();
    });
  });

  describe('formatRuntime', () => {
    it('formats runtimes correctly', () => {
      expect(formatRuntime('lambda')).toBe('Lambda');
      expect(formatRuntime('ecs_service')).toBe('ECS');
      expect(formatRuntime('k8s_workspace')).toBe('K8s Workspace');
      expect(formatRuntime('k8s_discovery')).toBe('K8s Discovery');
      expect(formatRuntime('custom_runtime_type')).toBe('custom runtime type');
    });
  });
});