/**
 * A real `git diff` (taken from a repo, nothing hand-written) that the review app's file tree cannot hold one row per
 * file for: `docs` becomes `docs/index.md` and `docs/guide/intro.md`, and a symlink becomes a regular file (the same
 * path twice). Its git order also differs from the tree's: root files sort before `src/`, the tree puts folders first.
 */
export const COLLIDING_PATHS_DIFF = `diff --git a/README.md b/README.md
index 3367afd..3e75765 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
diff --git a/a-link b/a-link
deleted file mode 120000
index 42061c0..0000000
--- a/a-link
+++ /dev/null
@@ -1 +0,0 @@
-README.md
\\ No newline at end of file
diff --git a/a-link b/a-link
new file mode 100644
index 0000000..2306374
--- /dev/null
+++ b/a-link
@@ -0,0 +1 @@
+now a regular file
diff --git a/aaa.ts b/aaa.ts
index 5626abf..814f4a4 100644
--- a/aaa.ts
+++ b/aaa.ts
@@ -1 +1,2 @@
 one
+two
diff --git a/docs b/docs
deleted file mode 100644
index e92d253..0000000
--- a/docs
+++ /dev/null
@@ -1 +0,0 @@
-I am a file called docs
diff --git a/docs/guide/intro.md b/docs/guide/intro.md
new file mode 100644
index 0000000..1c0d173
--- /dev/null
+++ b/docs/guide/intro.md
@@ -0,0 +1,2 @@
+hello
+intro
diff --git a/docs/index.md b/docs/index.md
new file mode 100644
index 0000000..94954ab
--- /dev/null
+++ b/docs/index.md
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/src/app.ts b/src/app.ts
index 20568bb..d353062 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-export const app = 1;
+export const app = 2;
diff --git a/src/extraordinarily-long-module-file-name-for-the-rail-12.ts b/src/extraordinarily-long-module-file-name-for-the-rail-12.ts
new file mode 100644
index 0000000..d6ec685
--- /dev/null
+++ b/src/extraordinarily-long-module-file-name-for-the-rail-12.ts
@@ -0,0 +1 @@
+export const LONG = 12;
`;
