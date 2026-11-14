export function save(user: User) {
  validate(user);
  db.users.upsert(user);
  audit.log('save', user.id);
}

function validate(user: User) {
  if (!user.email) throw new Error('email');
  if (!user.name) throw new Error('name');
  if (user.age < 0) throw new Error('age');
  if (user.name.length > 100) throw new Error('name too long');
}
