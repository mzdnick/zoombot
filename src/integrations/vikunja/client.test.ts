import { afterEach, describe, expect, it, vi } from 'vitest';
import { VikunjaClient, VikunjaNotFoundError } from './client.js';

const config = {
  url: 'http://vikunja:3456',
  projectId: 2,
  apiToken: 'api-token',
  webhookSecret: 'secret',
  userMap: {},
};

afterEach(() => vi.unstubAllGlobals());

describe('VikunjaClient', () => {
  it('creates markdown tasks through the v2 endpoint with bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 44, title: '#1 — Test' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VikunjaClient(config);
    await client.createTask(2, { title: '#1 — Test', description: 'Body', done: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://vikunja:3456/api/v2/projects/2/tasks?format=markdown');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer api-token');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ title: '#1 — Test', description: 'Body', done: false });
  });

  it('uses merge PATCH and the markdown header for a description change', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 44 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await new VikunjaClient(config).patchTask(44, { description: 'Updated', done: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://vikunja:3456/api/v2/tasks/44');
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('content-type')).toBe('application/merge-patch+json');
    expect(new Headers(init.headers).get('x-vikunja-format')).toBe('markdown');
    expect(JSON.parse(String(init.body))).toEqual({ description: 'Updated', done: true });
  });

  it('handles Vikunja 204 deletes without parsing a body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(new VikunjaClient(config).removeTaskLabel(44, 8)).resolves.toBeUndefined();
  });

  it('distinguishes 404s for stale task links', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      title: 'Not found', detail: 'The task no longer exists', code: 123,
    }), {
      status: 404,
      headers: { 'content-type': 'application/problem+json' },
    })));

    await expect(new VikunjaClient(config).getTask(44)).rejects.toEqual(expect.objectContaining({
      name: 'VikunjaNotFoundError',
      message: 'Not found: The task no longer exists',
      status: 404,
      code: 123,
    } satisfies Partial<VikunjaNotFoundError>));
  });

  it('surfaces problem details from non-404 failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      title: 'Validation failed', detail: 'title is required',
    }), {
      status: 422,
      headers: { 'content-type': 'application/problem+json' },
    })));

    await expect(new VikunjaClient(config).getProject(2)).rejects.toThrow('Validation failed: title is required');
  });
});
