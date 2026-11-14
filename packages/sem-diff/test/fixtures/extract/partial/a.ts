export function save(user: User) {
  if (!user.email) throw new Error('email');
  if (!user.name) throw new Error('name');
  if (user.age < 0) throw new Error('age');
  db.users.upsert(user);
  audit.log('save', user.id);
}
