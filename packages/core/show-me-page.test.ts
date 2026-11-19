import { expect, test } from "bun:test";
import { isShowMePage, showMePageTitle } from "./show-me-page";

const META = '<meta name="plannotator-page" content="show-me">';

test("a meta inside an HTML comment marks nothing, and a comment never hides a real one or names the page", () => {
  expect(isShowMePage(`<html><head><!-- ${META} --><title>Notes</title></head><body></body></html>`)).toBe(false);
  expect(isShowMePage(`<html><head><!--\n  old: ${META}\n--></head><body></body></html>`)).toBe(false);
  expect(isShowMePage(`<html><head><!-- draft --> ${META}</head><body></body></html>`)).toBe(true);
  expect(showMePageTitle(`<head><!-- <title>Old</title> --><title>New</title></head>`)).toBe("New");
});

test("only a real head meta marks the page, and only the head's title names it", () => {
  expect(isShowMePage(`<head><script>const s = '${META}';</script></head><body></body>`)).toBe(false);
  expect(isShowMePage(`<head><template>${META}</template></head><body></body>`)).toBe(false);
  expect(isShowMePage(`<head><meta data-name="plannotator-page" data-content="show-me"></head><body></body>`)).toBe(false);
  expect(isShowMePage(`<head><script>if (a <!--b) c("<body")</script>${META}</head><body></body>`)).toBe(true);
  expect(showMePageTitle(`<head>${META}</head><body><svg><title>Arrow tip</title></svg></body>`)).toBe("");
});
