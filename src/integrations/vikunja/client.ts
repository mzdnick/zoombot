import type { VikunjaConfig } from '../../config.js';

export interface VikunjaUser {
  id: number;
  username?: string;
  name?: string;
}

export interface VikunjaLabel {
  id: number;
  title: string;
}

export interface VikunjaTask {
  id: number;
  title: string;
  description?: string;
  done?: boolean;
  due_date?: string | null;
  labels?: VikunjaLabel[] | null;
  assignees?: VikunjaUser[] | null;
}

export interface VikunjaComment {
  id: number;
  comment: string;
  author?: VikunjaUser;
}

export interface VikunjaProject {
  id: number;
  title?: string;
}

export interface VikunjaPage<T> {
  items: T[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export interface VikunjaTaskPatch {
  title?: string;
  description?: string;
  done?: boolean;
  due_date?: string | null;
}

export class VikunjaError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = 'VikunjaError';
  }
}

export class VikunjaNotFoundError extends VikunjaError {
  constructor(message: string, code?: number) {
    super(message, 404, code);
    this.name = 'VikunjaNotFoundError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  expected?: number[];
}

export class VikunjaClient {
  private readonly base: string;

  constructor(private readonly config: VikunjaConfig) {
    this.base = `${config.url}/api/v2`;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiToken}`,
      Accept: 'application/json',
      ...options.headers,
    };
    if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${this.base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(10_000),
    });
    const expected = options.expected ?? [200];
    if (!expected.includes(response.status)) {
      const text = await response.text();
      let title = response.statusText || `Vikunja request failed (${response.status})`;
      let detail = '';
      let code: number | undefined;
      try {
        const problem = JSON.parse(text) as { title?: unknown; detail?: unknown; code?: unknown };
        if (typeof problem.title === 'string') title = problem.title;
        if (typeof problem.detail === 'string') detail = problem.detail;
        if (typeof problem.code === 'number') code = problem.code;
      } catch { /* non-JSON error body */ }
      const message = detail ? `${title}: ${detail}` : title;
      if (response.status === 404) throw new VikunjaNotFoundError(message, code);
      throw new VikunjaError(message, response.status, code);
    }
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getCurrentUser(): Promise<VikunjaUser> {
    return this.request('/user');
  }

  getProject(projectId: number): Promise<VikunjaProject> {
    return this.request(`/projects/${projectId}`);
  }

  getTask(taskId: number): Promise<VikunjaTask> {
    return this.request(`/tasks/${taskId}?format=markdown`);
  }

  createTask(projectId: number, task: Pick<VikunjaTask, 'title' | 'description' | 'done' | 'due_date'>): Promise<VikunjaTask> {
    return this.request(`/projects/${projectId}/tasks?format=markdown`, {
      method: 'POST',
      body: task,
      expected: [201],
    });
  }

  patchTask(taskId: number, patch: VikunjaTaskPatch): Promise<VikunjaTask> {
    const headers: Record<string, string> = { 'Content-Type': 'application/merge-patch+json' };
    if (Object.hasOwn(patch, 'description')) headers['X-Vikunja-Format'] = 'markdown';
    return this.request(`/tasks/${taskId}`, { method: 'PATCH', body: patch, headers });
  }

  async listLabels(): Promise<VikunjaLabel[]> {
    const page = await this.request<VikunjaPage<VikunjaLabel>>('/labels?per_page=1000');
    return page.items;
  }

  addTaskLabel(taskId: number, labelId: number): Promise<unknown> {
    return this.request(`/tasks/${taskId}/labels`, {
      method: 'POST',
      body: { label_id: labelId },
      expected: [201],
    });
  }

  removeTaskLabel(taskId: number, labelId: number): Promise<void> {
    return this.request(`/tasks/${taskId}/labels/${labelId}`, { method: 'DELETE', expected: [204] });
  }

  createComment(taskId: number, comment: string): Promise<VikunjaComment> {
    return this.request(`/tasks/${taskId}/comments?format=markdown`, {
      method: 'POST',
      body: { comment },
      expected: [201],
    });
  }

  getComment(taskId: number, commentId: number): Promise<VikunjaComment> {
    return this.request(`/tasks/${taskId}/comments/${commentId}?format=markdown`);
  }

  addAssignee(taskId: number, userId: number): Promise<unknown> {
    return this.request(`/tasks/${taskId}/assignees`, {
      method: 'POST',
      body: { user_id: userId },
      expected: [201],
    });
  }

  removeAssignee(taskId: number, userId: number): Promise<void> {
    return this.request(`/tasks/${taskId}/assignees/${userId}`, { method: 'DELETE', expected: [204] });
  }

  createRelation(taskId: number, otherTaskId: number): Promise<unknown> {
    return this.request(`/tasks/${taskId}/relations`, {
      method: 'POST',
      body: { other_task_id: otherTaskId, relation_kind: 'related' },
      expected: [201],
    });
  }
}
