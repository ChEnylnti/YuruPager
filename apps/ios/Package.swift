// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "YuruPagerCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v13),
    ],
    products: [
        .library(name: "YuruPagerCore", targets: ["YuruPagerCore"]),
        .executable(name: "yurupager-core-checks", targets: ["YuruPagerCoreChecks"]),
    ],
    targets: [
        .target(
            name: "YuruPagerCore",
            path: "YuruPager/Core"
        ),
        .executableTarget(
            name: "YuruPagerCoreChecks",
            dependencies: ["YuruPagerCore"],
            path: "YuruPagerCoreChecks"
        ),
        .testTarget(
            name: "YuruPagerCoreTests",
            dependencies: ["YuruPagerCore"],
            path: "YuruPagerCoreTests"
        ),
    ]
)
