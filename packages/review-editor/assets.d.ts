/** Vite builds local worker entries as constructors backed by inline scripts. */
declare module '*.worker?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
