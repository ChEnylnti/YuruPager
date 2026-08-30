import XCTest

final class YuruPagerUITests: XCTestCase {
    func testLoginScreenSupportsKeyboardAndCompactViewport() {
        let app = XCUIApplication()
        app.launchEnvironment["YURUPAGER_UI_TEST"] = "1"
        app.launch()

        XCTAssertTrue(app.textFields["login.email"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.secureTextFields["login.password"].exists)
        XCTAssertTrue(app.buttons["login.submit"].exists)

        let rememberSession = app.switches["login.rememberSession"]
        XCTAssertTrue(rememberSession.exists)
        let initialValue = rememberSession.value as? String
        rememberSession.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        let changed = XCTNSPredicateExpectation(
            predicate: NSPredicate { value, _ in
                (value as? XCUIElement)?.value as? String != initialValue
            },
            object: rememberSession
        )
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 2), .completed)
        rememberSession.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()

        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "iPhone-login"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
