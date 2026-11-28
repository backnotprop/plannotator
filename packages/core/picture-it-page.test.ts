import { expect, test } from "bun:test";
import { isPictureItPage, pictureItPageTitle } from "./picture-it-page";

const META = '<meta name="plannotator-page" content="picture-it">';

test("a meta inside an HTML comment marks nothing, and a comment never hides a real one or names the page", () => {
  expect(isPictureItPage(`<html><head><!-- ${META} --><title>Notes</title></head><body></body></html>`)).toBe(false);
  expect(isPictureItPage(`<html><head><!--\n  old: ${META}\n--></head><body></body></html>`)).toBe(false);
  expect(isPictureItPage(`<html><head><!-- draft --> ${META}</head><body></body></html>`)).toBe(true);
  expect(pictureItPageTitle(`<head><!-- <title>Old</title> --><title>New</title></head>`)).toBe("New");
});

test("only a real head meta marks the page, and only the head's title names it", () => {
  expect(isPictureItPage(`<head><script>const s = '${META}';</script></head><body></body>`)).toBe(false);
  expect(isPictureItPage(`<head><template>${META}</template></head><body></body>`)).toBe(false);
  expect(isPictureItPage(`<head><meta data-name="plannotator-page" data-content="picture-it"></head><body></body>`)).toBe(false);
  expect(isPictureItPage(`<head><script>if (a <!--b) c("<body")</script>${META}</head><body></body>`)).toBe(true);
  expect(pictureItPageTitle(`<head>${META}</head><body><svg><title>Arrow tip</title></svg></body>`)).toBe("");
});

test("a hostile megabyte of unclosed tags is read at once, and blocks that only look like script or comment hide nothing", () => {
  const started = performance.now();
  expect(isPictureItPage("<meta ".repeat(180_000))).toBe(false);
  expect(isPictureItPage(`${META}<title>${"<title ".repeat(150_000)}`)).toBe(true);
  expect(pictureItPageTitle(`${META}<title>${"<title ".repeat(150_000)}`)).toBe("");
  expect(performance.now() - started).toBeLessThan(1000);
  expect(isPictureItPage(`<head><!-- <script> -->${META}</head><body></body>`)).toBe(true);
  expect(isPictureItPage(`<head><style-x></style-x>${META}</head><body></body>`)).toBe(true);
  expect(pictureItPageTitle(`<HEAD><TITLE>İ Big\n  title</TITLE>${META}</HEAD>`)).toBe("İ Big title");
});
