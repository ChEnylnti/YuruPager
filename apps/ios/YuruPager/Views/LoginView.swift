import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var store: AppStore
    @AppStorage("rememberSession") private var rememberSession = true
    @State private var email = ""
    @State private var password = ""
    @State private var serverAddress = ""
    @State private var showServer = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Field?

    private enum Field { case email, password, server }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("邮箱", text: $email)
                        .accessibilityIdentifier("login.email")
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .password }
                    SecureField("密码", text: $password)
                        .accessibilityIdentifier("login.password")
                        .textContentType(.password)
                        .focused($focusedField, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                } header: {
                    Text("登录")
                }

                Section {
                    DisclosureGroup("服务器", isExpanded: $showServer) {
                        TextField("https://example.com/yurupager/", text: $serverAddress)
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focusedField, equals: .server)
                            .accessibilityLabel("YuruPager 服务器地址")
                    }
                    Toggle("保持登录", isOn: $rememberSession)
                        .accessibilityIdentifier("login.rememberSession")
                        .accessibilityHint("开启后在本机 Keychain 保存登录会话，不保存密码")
                } footer: {
                    Text("保持登录只保存加密会话，不保存明文密码。")
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .accessibilityLabel("错误：\(errorMessage)")
                    }
                }

                Section {
                    Button(action: submit) {
                        HStack {
                            Spacer()
                            if isSubmitting { ProgressView().controlSize(.small) }
                            Text(isSubmitting ? "正在登录" : "登录")
                            Spacer()
                        }
                    }
                    .accessibilityIdentifier("login.submit")
                    .disabled(isSubmitting || email.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                    .accessibilityHint("登录后从服务器恢复工作空间和待处理请求")
                }
            }
            .navigationTitle("YuruPager")
            .navigationBarTitleDisplayMode(.large)
            .onAppear { serverAddress = store.configuration.baseURL.absoluteString }
        }
    }

    private func submit() {
        guard !isSubmitting else { return }
        errorMessage = nil
        if serverAddress != store.configuration.baseURL.absoluteString,
           !store.configureServer(address: serverAddress) {
            errorMessage = "请输入有效的 HTTPS 地址；HTTP 仅允许 localhost"
            return
        }
        isSubmitting = true
        Task {
            defer { isSubmitting = false }
            do {
                try await store.login(
                    email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                    password: password,
                    rememberSession: rememberSession
                )
                password = ""
            } catch {
                password = ""
                errorMessage = Labels.error(error, fallback: "无法登录")
            }
        }
    }
}
