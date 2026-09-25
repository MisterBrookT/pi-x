import XCTest

final class RemoteSafariTests: XCTestCase {
    func testPhoneJourney() throws {
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.activate()
        XCTAssertTrue(safari.staticTexts["Pix simulator test"].waitForExistence(timeout: 15), safari.debugDescription)
        XCTAssertTrue(safari.staticTexts["Review the project structure"].exists)
        XCTAssertFalse(safari.staticTexts["Reconnecting…"].exists)
        // Mac-rendered Markdown: a real table and a Mermaid diagram, not raw source.
        XCTAssertTrue(safari.staticTexts["Mac Pi"].waitForExistence(timeout: 5), "table cell renders")
        XCTAssertFalse(safari.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "flowchart LR")).firstMatch.exists, "Mermaid source is drawn, not shown raw")
        safari.screenshot().image.addAttachment(named: "rich-markdown")

        let web = safari.webViews.firstMatch
        XCTAssertTrue(web.exists)
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.10, dy: 0.64))
            .press(forDuration: 0.05, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.68, dy: 0.64)))
        XCTAssertTrue(safari.staticTexts["Sessions"].waitForExistence(timeout: 5), "edge swipe should open sessions")
        safari.screenshot().image.addAttachment(named: "swipe-open")
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.72))
            .press(forDuration: 0.05, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.72)))
        let sessions = safari.buttons["Sessions"]
        XCTAssertTrue(sessions.exists, safari.debugDescription)
        sessions.tap()
        XCTAssertTrue(safari.staticTexts["Sessions"].waitForExistence(timeout: 5))
        XCTAssertTrue(safari.staticTexts["Pix simulator test"].exists)
        safari.screenshot().image.addAttachment(named: "session-list")

        let sessionRow = safari.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pix simulator test")).firstMatch
        XCTAssertTrue(sessionRow.isHittable, safari.debugDescription)
        sessionRow.tap()
        let input = safari.textViews["Message Pi"]
        XCTAssertTrue(input.waitForExistence(timeout: 5), safari.debugDescription)
        input.tap()
        input.typeText("First line\nSecond line")
        XCTAssertTrue(String(describing: input.value ?? "").contains("\n"), "Return should enter a newline on iPhone")
        safari.webViews.buttons["Send"].tap()
        XCTAssertTrue(safari.staticTexts["First line\nSecond line"].waitForExistence(timeout: 10))
        XCTAssertTrue(safari.staticTexts["Phone prompt reached the same session."].waitForExistence(timeout: 10))
        safari.screenshot().image.addAttachment(named: "phone-to-session")

        // A real PNG from a Pi tool result shows in the conversation without opening the tool group.
        let picture = safari.buttons["View tool image"].firstMatch
        XCTAssertTrue(picture.waitForExistence(timeout: 10), safari.debugDescription)
        let loading = safari.staticTexts["Loading image…"]
        XCTAssertTrue(loading.waitForNonExistence(timeout: 10), "picture loads through authenticated media")
        safari.screenshot().image.addAttachment(named: "tool-image")
        picture.tap()
        XCTAssertTrue(safari.buttons["Close image"].waitForExistence(timeout: 5), safari.debugDescription)
        safari.screenshot().image.addAttachment(named: "image-full-screen")
    }
}

private extension UIImage {
    func addAttachment(named name: String) {
        let attachment = XCTAttachment(image: self)
        attachment.name = name
        attachment.lifetime = .keepAlways
        XCTContext.runActivity(named: name) { $0.add(attachment) }
    }
}
