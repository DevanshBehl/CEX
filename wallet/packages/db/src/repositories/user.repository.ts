import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';
import type { UserRecord } from './types.js';

export interface CreateUserInput {
  email?: string | undefined;
  displayName?: string | undefined;
}

export interface UserRepository {
  create(input: CreateUserInput, tx?: Executor): Promise<UserRecord>;
  findById(id: string, tx?: Executor): Promise<UserRecord | null>;
  findByEmail(email: string, tx?: Executor): Promise<UserRecord | null>;
  update(
    id: string,
    patch: { email?: string; displayName?: string },
    tx?: Executor,
  ): Promise<UserRecord>;
}

export function createUserRepository(db: Executor): UserRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async create(input, tx) {
      return exec(tx).user.create({
        data: {
          id: newId(),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        },
      });
    },

    async findById(id, tx) {
      return exec(tx).user.findUnique({ where: { id } });
    },

    async findByEmail(email, tx) {
      return exec(tx).user.findUnique({ where: { email } });
    },

    async update(id, patch, tx) {
      return exec(tx).user.update({ where: { id }, data: patch });
    },
  };
}
