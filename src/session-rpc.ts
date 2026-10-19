import type { Session, Turn, Checkpoint, Message } from './session-types.js';
import type { Config } from './schema.js';
export const SESSION_PROTOCOL_VERSION = 2;
export interface SessionRpc {
  'sessions.create': {
    args: { repo: string; pool?: string; lead?: string; config?: Config };
    result: Session;
  };
  'sessions.list': { args: Record<string, never>; result: Session[] };
  'sessions.submit': { args: { id: string; clientMessageId: string; input: string }; result: Turn };
  'sessions.history': {
    args: { id: string; after?: number; limit?: number };
    result: (Message & { seq: number })[];
  };
  'sessions.events': {
    args: { id: string; after?: number };
    result: { seq: number; type: string; at: string; data: unknown }[];
  };
  'sessions.resume': { args: { id: string }; result: Session };
  'sessions.interrupt': { args: { id: string }; result: Session };
  'sessions.compact': { args: { id: string }; result: Checkpoint };
  'sessions.answer': {
    args: {
      id: string;
      questionId: string;
      answer: string;
      answers?: Record<string, { answers: string[] }>;
    };
    result: Turn | { answered: true };
  };
  'sessions.review': {
    args: { id: string };
    result: { version: number; hash: string; patch: string; stat: string };
  };
  'sessions.apply': { args: { id: string }; result: Session };
  'sessions.refresh': { args: { id: string }; result: Session };
}
