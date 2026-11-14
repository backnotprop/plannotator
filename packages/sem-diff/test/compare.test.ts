// Cases other tools caught that sem-diff missed, found by the head-to-head comparisons
// (harness/compare): RefactoringMiner on real commits, the generated changes for renames.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';
import type { LanguageId } from '../src/parse.ts';

const kinds = async (lang: LanguageId, a: string, b: string) =>
  (await semanticDiffFile(lang, a, b)).semanticOperations.map((o) => o.type).filter((t) => t !== 'edited' && t !== 'added' && t !== 'deleted');

test('code moved into a new overload of the same name is an extract (kafka consumeMessages)', async () => {
  const a = `class Tester {
    private static Path consumeMessages(String brokerUrl, Set<String> topics) throws IOException {
        Path consumedFilePath = Files.createTempFile("kafka-log-cleaner-consumed-", ".txt");
        System.out.println("Logging consumed messages to " + consumedFilePath);
        try (Consumer<String, String> consumer = createConsumer(brokerUrl);
             BufferedWriter consumedWriter = Files.newBufferedWriter(consumedFilePath, StandardCharsets.UTF_8)) {
            consumer.subscribe(topics);
            consumer.poll(Duration.ofSeconds(20)).forEach(record -> write(consumedWriter, record));
            return consumedFilePath;
        }
    }
}
`;
  const b = `class Tester {
    private static Path consumeMessages(String brokerUrl, Set<String> topics) throws IOException {
        try (Consumer<String, String> consumer = createConsumer(brokerUrl)) {
            return consumeMessages(consumer, topics);
        }
    }

    static Path consumeMessages(Consumer<String, String> consumer, Set<String> topics) throws IOException {
        Path consumedFilePath = Files.createTempFile("kafka-log-cleaner-consumed-", ".txt");
        System.out.println("Logging consumed messages to " + consumedFilePath);
        try (BufferedWriter consumedWriter = Files.newBufferedWriter(consumedFilePath, StandardCharsets.UTF_8)) {
            consumer.subscribe(topics);
            consumer.poll(Duration.ofSeconds(20)).forEach(record -> write(consumedWriter, record));
            return consumedFilePath;
        }
    }
}
`;
  assert.deepEqual(await kinds('java', a, b), ['extractedFunction']);
});

test('renamed Java lambda parameter', async () => {
  const a = `class A { void f(Map<String, String> m) { m.forEach((key, value) -> {\n  if (key.isEmpty()) return;\n  put(key, value);\n}); } }\n`;
  const b = `class A { void f(Map<String, String> m) { m.forEach((name, value) -> {\n  if (name.isEmpty()) return;\n  put(name, value);\n}); } }\n`;
  assert.deepEqual(await kinds('java', a, b), ['renamed']);
});

test('renamed Go parameter declared alongside another (dirs, names []string)', async () => {
  const a = `package p\n\nfunc FindFile(dirs, names []string) string {\n\tfor _, name := range names {\n\t\t_ = name\n\t}\n\treturn ""\n}\n`;
  const b = `package p\n\nfunc FindFile(dirs, files []string) string {\n\tfor _, name := range files {\n\t\t_ = name\n\t}\n\treturn ""\n}\n`;
  assert.deepEqual(await kinds('go', a, b), ['renamed']);
});

test('renamed Python except-as variable', async () => {
  const a = `def load(self):\n    try:\n        self.setup()\n    except ImproperlyConfigured as exc:\n        self.settings_exception = exc\n`;
  const b = `def load(self):\n    try:\n        self.setup()\n    except ImproperlyConfigured as error:\n        self.settings_exception = error\n`;
  assert.deepEqual(await kinds('python', a, b), ['renamed']);
});
