import PlannotatorKit
import SwiftUI

struct PairTarget: Identifiable, Hashable {
    var name: String
    var address: InboxAddress
    var id: String { address.hostPort }
}

/// 1.3: computers this phone knows on the tailnet, and a row to type the
/// address the Inbox shows. A tailnet cannot be listed from another app, so
/// nothing here is discovered. The six digits are always typed.
struct NearbyScreen: View {
    @Environment(AppModel.self) private var model
    @State private var typed = ""
    @State private var target: PairTarget?
    @FocusState private var typing: Bool

    var body: some View {
        List {
            Section {
                ForEach(model.known) { computer in
                    Button {
                        target = PairTarget(name: computer.name, address: computer.address)
                    } label: {
                        HStack(spacing: 13) {
                            ComputerTile()
                            VStack(alignment: .leading, spacing: 1) {
                                Text(computer.name).foregroundStyle(Color.ink)
                                Text(computer.address.hostPort).font(.footnote).foregroundStyle(Color.inkSecondary)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        }
                    }
                }
                HStack {
                    TextField("macbook.tail0000.ts.net:8443", text: $typed)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($typing)
                        .onSubmit(go)
                        .accessibilityLabel("The Inbox's address")
                        .accessibilityIdentifier("address-field")
                    if InboxAddress(typed) != nil {
                        Button("Next", action: go).fontWeight(.semibold).accessibilityIdentifier("address-next")
                    }
                }
            } header: {
                Text("On your tailnet").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).textCase(nil)
            } footer: {
                Text("Type the address the Inbox shows under Pair a phone. Tailscale must be on.")
            }
            .listRowBackground(Color.card)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.ground)
        .navigationTitle("Find it nearby")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(nil, for: .navigationBar)
        .sheet(item: $target) { target in
            CodeSheet(target: target)
                .presentationDetents([.height(250)])
                .presentationDragIndicator(.visible)
        }
    }

    private func go() {
        guard let address = InboxAddress(typed) else { return }
        typing = false
        let known = model.known.first { $0.address == address }
        target = PairTarget(name: known?.name ?? address.host, address: address)
    }
}

/// The six digits the computer shows (1.3's sheet). The sixth digit sends.
struct CodeSheet: View {
    let target: PairTarget
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var digits = ""
    @State private var problem: String?
    @State private var busy = false
    @State private var shakes = 0
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .title) private var box: CGFloat = 46

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text(problem ?? "Enter the code your computer shows.")
                    .font(.subheadline)
                    .foregroundStyle(problem == nil ? Color.inkSecondary : Color.destructive)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                    .accessibilityIdentifier("code-message")
                boxes
                    .modifier(Shake(shakes: shakes))
                    .overlay {
                        TextField("", text: $digits)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .focused($focused)
                            .foregroundStyle(.clear)
                            .tint(.clear)
                            .opacity(0.02)
                            .accessibilityLabel("Pairing code")
                            .accessibilityValue(digits)
                            .accessibilityIdentifier("pairing-code")
                    }
                if busy { ProgressView() }
                Spacer(minLength: 0)
            }
            .padding(.top, 4)
            .navigationTitle("Pair with \(target.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() } }
            }
        }
        .onAppear { focused = true }
        .onChange(of: digits) { _, value in
            let clean = String(value.filter(\.isNumber).prefix(6))
            if clean != value { digits = clean }
            if clean.count == 6 { submit(clean) }
        }
    }

    private var boxes: some View {
        HStack(spacing: 9) {
            ForEach(0..<6, id: \.self) { index in
                let chars = Array(digits)
                let current = index == chars.count && focused && !busy
                ZStack {
                    RoundedRectangle(cornerRadius: 13).fill(Color.card)
                    RoundedRectangle(cornerRadius: 13).strokeBorder(current ? Color.tint : Color.hairline, lineWidth: current ? 2 : 1)
                    if index < chars.count {
                        Text(String(chars[index])).font(.title.weight(.semibold)).monospacedDigit()
                    } else if current {
                        RoundedRectangle(cornerRadius: 1).fill(Color.tint).frame(width: 2, height: box * 0.5)
                    }
                }
                .frame(width: box, height: box * 1.26)
                if index == 2 { Spacer().frame(width: 6) }
            }
        }
        .accessibilityHidden(true)
    }

    private func submit(_ code: String) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do throws(InboxError) {
                try await model.pair(address: target.address, code: code)
                Haptics.success()
            } catch {
                Haptics.error()
                if case .refused(_, "pairing_code_wrong", let message, let left?) = error {
                    problem = left > 0 ? "\(message) \(plural(left, "try", "tries")) left." : "\(message) Make a new code on your computer."
                } else if error == .unreachable {
                    problem = "Can't reach \(target.address.hostPort). Check the address, and that Tailscale is on."
                } else {
                    problem = error.message
                }
                digits = ""
                if reduceMotion { shakes += 1 } else { withAnimation(.default) { shakes += 1 } }
            }
        }
    }
}

/// A wrong code shakes the boxes, as iOS does for a wrong passcode.
private struct Shake: GeometryEffect {
    var shakes: Int
    var animatableData: CGFloat
    init(shakes: Int) {
        self.shakes = shakes
        animatableData = CGFloat(shakes)
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 8 * sin(animatableData * .pi * 4), y: 0))
    }
}
