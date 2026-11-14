import { db } from './db';

export function formatUser(user: User): string {
  const name = `${user.first} ${user.last}`;
  return `${name} <${user.email}>`;
}

export async function loadUser(id: string) {
  return db.users.find(id);
}
