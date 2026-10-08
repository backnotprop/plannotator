import Testing
@testable import PlannotatorKit

// The split decides which question record a card draws: a wrong split draws
// one question's choices under another's prompt.
@Suite struct MessageBlocksTests {
    @Test func questionsSplitInBodyOrder() {
        let body = """
        I checked the 409 row against the Stripe docs.

        :::question
        Which way?
        - [ ] Retry
        :::

        Between them.

        :::question-multi
        Which files?
        - [ ] a
        :::
        """
        #expect(MessageBlock.parse(body) == [
            .paragraph("I checked the 409 row against the Stripe docs."),
            .question(index: 0),
            .paragraph("Between them."),
            .question(index: 1),
        ])
    }

    @Test func aQuestionInsideAFenceIsCode() {
        let body = "```md\n:::question\nNot a card\n:::\n```\n\n:::question\nReal\n- [ ] Yes\n:::"
        let blocks = MessageBlock.parse(body)
        #expect(blocks.count == 2)
        #expect(blocks.last == .question(index: 0))
    }

    @Test func blocksThePhoneDoesNotDrawAreRows() {
        let body = "| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD\n```\n\n$$\nx^2\n$$\n\n<div>hi</div>"
        #expect(MessageBlock.parse(body) == [.rich(.table), .rich(.diagram), .rich(.math), .rich(.html)])
    }

    @Test func listsKeepTheirMarkersAndDepth() {
        let blocks = MessageBlock.parse("- one\n  - two\n1. first")
        #expect(blocks == [.list([
            .init(marker: "•", depth: 0, text: "one"),
            .init(marker: "•", depth: 1, text: "two"),
            .init(marker: "1.", depth: 0, text: "first"),
        ])])
    }
}
