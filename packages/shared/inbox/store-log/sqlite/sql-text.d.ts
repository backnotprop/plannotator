/** A migration imported as text (`with { type: "text" }`, migrations.ts): Bun hands over the file's contents. */
declare module "*.sql" {
  const text: string;
  export default text;
}
