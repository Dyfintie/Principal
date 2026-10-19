import { createServer, type Server } from 'node:net';
import { mkdir, chmod, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Graph, TaskRecord } from './schema.js';
import { validateGraph } from './schema.js';
export class SupervisorBridge {
  server: Server | null = null;
  proposal: Graph | null = null;
  constructor(
    readonly directory: string,
    readonly pool: string,
    readonly maxTasks: number,
    private tasks: () => TaskRecord[],
    private cancelTask: (id: string) => Promise<void>,
  ) {}
  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const socketPath = path.join(this.directory, 'bridge.sock');
    await rm(socketPath, { force: true });
    this.server = createServer({ allowHalfOpen: true }, (socket) => {
      let data = '';
      socket.on('data', (b) => {
        data += b;
        if (data.length > 1024 * 1024) socket.destroy();
      });
      socket.on('end', async () => {
        try {
          const request = JSON.parse(data);
          const result = await this.call(request.name, request.arguments ?? {});
          socket.end(JSON.stringify({ result }));
        } catch (e) {
          socket.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  }
  async stop() {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    await rm(this.directory, { recursive: true, force: true });
  }
  private async call(name: string, args: any) {
    const tasks = this.tasks();
    if (name === 'submit_task_graph' || name === 'propose_task_revision') {
      const graph = validateGraph(args.graph);
      if (graph.pool !== this.pool || graph.tasks.length > this.maxTasks)
        throw new Error('Proposal exceeds the approved pool or task count');
      this.proposal = graph;
      return { accepted: true, taskCount: graph.tasks.length };
    }
    if (name === 'list_task_status')
      return tasks.map((t) => ({ id: t.id, status: t.status, attempts: t.attempts }));
    if (name === 'read_task_result') {
      const task = tasks.find((t) => t.id === args.taskId);
      if (!task) throw new Error('Unknown task');
      return { id: task.id, status: task.status, result: task.result };
    }
    if (name === 'read_artifact') {
      const task = tasks.find((t) => t.id === args.taskId);
      if (!task?.checkpoint || args.kind !== 'patch')
        throw new Error('Only accepted task patch artifacts are exposed');
      const data = await readFile(task.checkpoint);
      if (data.length > 1024 * 1024) throw new Error('Artifact exceeds supervisor read limit');
      return { taskId: task.id, kind: 'patch', content: data.toString() };
    }
    if (name === 'cancel_task') {
      if (!tasks.some((t) => t.id === args.taskId)) throw new Error('Unknown task');
      await this.cancelTask(args.taskId);
      return { canceled: true };
    }
    throw new Error('Unknown supervisor tool');
  }
}
