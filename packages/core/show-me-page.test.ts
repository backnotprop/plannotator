import { expect, test } from "bun:test";
import { isShowMePage, showMePageTitle } from "./show-me-page";

const META = '<meta name="plannotator-page" content="show-me">';

test("a meta inside an HTML comment marks nothing, and a comment never hides a real one or names the page", () => {
  expect(isShowMePage(`<html><head><!-- ${META} --><title>Notes</title></head><body></body></html>`)).toBe(false);
  expect(isShowMePage(`<html><head><!--\n  old: ${META}\n--></head><body></body></html>`)).toBe(false);
  expect(isShowMePage(`<html><head><!-- draft --> ${META}</head><body></body></html>`)).toBe(true);
  expect(showMePageTitle(`<head><!-- <title>Old</title> --><title>New</title></head>`)).toBe("New");
});
