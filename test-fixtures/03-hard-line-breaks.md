# Hard Line Break Tests

## Two trailing spaces (standard hard break)

This line has two trailing spaces  
and this should appear on a new line.

## Backslash hard break

This line ends with a backslash\
and this should appear on a new line.

## Soft wrap (should NOT break)

This line has no trailing spaces
and should flow as a single line with a space between.

## Multiple hard breaks in a row

Line one  
Line two  
Line three  
Line four

## Hard break inside a list item

- This list item has a hard break  
  and continues on the next visual line
- Normal item after

## Hard break with inline formatting

**Bold text with break  
continuation** and more text.

This has `inline code` then a break  
and continues here.

## Paragraph with no breaks (control case)

This is just a normal paragraph with no special line break handling.
It should render as flowing text with spaces between lines.
Nothing should change here at all.
