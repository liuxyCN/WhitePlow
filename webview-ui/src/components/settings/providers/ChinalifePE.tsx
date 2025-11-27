import { useState, useCallback, useEffect, useMemo } from "react"
import { useEvent, useDebounce } from "react-use"
import { Checkbox } from "vscrui"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings, ModelInfo, OrganizationAllowList, ReasoningEffort } from "@roo-code/types"
import {
	openAiModelInfoSaneDefaults,
	chinalifePEDefaultModelId,
	chinalifePEModels as predefinedChinalifePEModels,
} from "@roo-code/types"

import { ExtensionMessage } from "@roo/ExtensionMessage"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import { Button, StandardTooltip } from "@src/components/ui"

import { inputEventTransform, noTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"
import { R1FormatSetting } from "../R1FormatSetting"
import { ThinkingBudget } from "../ThinkingBudget"
import { convertHeadersToObject } from "../utils/headers"
import { Modal } from "../../common/Modal"

type ChinalifePEProps = {
	apiConfiguration?: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	fromWelcomeView?: boolean
}

export const ChinalifePE = ({
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	modelValidationError,
	fromWelcomeView,
}: ChinalifePEProps) => {
	const { t } = useAppTranslation()

	const [chinalifePEModels, setChinalifePEModels] = useState<Record<string, ModelInfo> | null>(null)
	const [openAiLegacyFormatSelected, setOpenAiLegacyFormatSelected] = useState(
		!!apiConfiguration?.openAiLegacyFormat,
	)
	const [username, setUsername] = useState("")
	const [password, setPassword] = useState("")
	const [isLoggingIn, setIsLoggingIn] = useState(false)
	const [showInviteCodeDialog, setShowInviteCodeDialog] = useState(false)
	const [inviteCode, setInviteCode] = useState("")
	const [isSubmittingInviteCode, setIsSubmittingInviteCode] = useState(false)
	const [loginErrorMessage, setLoginErrorMessage] = useState<string | undefined>(undefined)

	const [customHeaders, setCustomHeaders] = useState<[string, string][]>(() => {
		const headers = apiConfiguration?.openAiHeaders || {}
		return Object.entries(headers)
	})

	// 判断当前选择的模型是否是自定义模型（不在预定义的 chinalifePEModels 中）
	const isCustomModel = useMemo(() => {
		const selectedModelId = apiConfiguration?.openAiModelId
		if (!selectedModelId) return false
		return !(selectedModelId in predefinedChinalifePEModels)
	}, [apiConfiguration?.openAiModelId])

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	const handleAddCustomHeader = useCallback(() => {
		setCustomHeaders((prev) => [...prev, ["", ""]])
	}, [])

	const handleUpdateHeaderKey = useCallback((index: number, newKey: string) => {
		setCustomHeaders((prev) => {
			const updated = [...prev]
			if (updated[index]) {
				updated[index] = [newKey, updated[index][1]]
			}
			return updated
		})
	}, [])

	const handleUpdateHeaderValue = useCallback((index: number, newValue: string) => {
		setCustomHeaders((prev) => {
			const updated = [...prev]
			if (updated[index]) {
				updated[index] = [updated[index][0], newValue]
			}
			return updated
		})
	}, [])

	const handleRemoveCustomHeader = useCallback((index: number) => {
		setCustomHeaders((prev) => prev.filter((_, i) => i !== index))
	}, [])

	// 更新父组件的 headers 状态
	useEffect(() => {
		const timer = setTimeout(() => {
			const headerObject = convertHeadersToObject(customHeaders)
			setApiConfigurationField("openAiHeaders", headerObject)
		}, 300)
		return () => clearTimeout(timer)
	}, [customHeaders, setApiConfigurationField])

	const handleLogin = useCallback(() => {
		if (!username.trim() || !password.trim()) {
			setLoginErrorMessage(t("settings:providers.chinalifePELogin.usernamePasswordRequired"))
			return
		}

		setIsLoggingIn(true)
		setLoginErrorMessage(undefined)

		// 从 apiConfiguration 获取 baseUrl
		const apiUrl = apiConfiguration?.openAiBaseUrl || "https://ai.chinalifepe.com"

		vscode.postMessage({
			type: "chinalifePELogin",
			values: {
				username: username.trim(),
				password: password.trim(),
				apiUrl: apiUrl,
			},
		})
	}, [username, password, apiConfiguration])

	const handleSubmitInviteCode = useCallback(() => {
		if (!inviteCode.trim() || !username.trim() || !password.trim()) {
			setLoginErrorMessage(t("settings:providers.chinalifePELogin.inviteCodeRequired"))
			return
		}

		setIsSubmittingInviteCode(true)
		setLoginErrorMessage(undefined)

		// 使用用户名和密码重新登录获取新ticket，然后用新ticket和邀请码获取apikey
		// 从 apiConfiguration 获取 baseUrl
		const apiUrl = apiConfiguration?.openAiBaseUrl || "https://ai.chinalifepe.com"

		vscode.postMessage({
			type: "chinalifePELogin",
			values: {
				username: username.trim(),
				password: password.trim(),
				inviteCode: inviteCode.trim(),
				apiUrl: apiUrl,
			},
		})
	}, [inviteCode, username, password, apiConfiguration])

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		switch (message.type) {
			case "chinalifePEModels": {
				const updatedModels = message.chinalifePEModels ?? []
				setChinalifePEModels(Object.fromEntries(updatedModels.map((item) => [item, openAiModelInfoSaneDefaults])))
				break
			}
			case "chinalifePELoginResponse": {
				if (message.chinalifePELoginResponse?.success) {
					setIsLoggingIn(false)
					setIsSubmittingInviteCode(false)
					console.log("登录成功，apiKey:", message.chinalifePELoginResponse.apiKey)
					setShowInviteCodeDialog(false)
					setInviteCode("")
					// 如果登录成功，设置 API Key
					if (message.chinalifePELoginResponse.apiKey) {
						setApiConfigurationField("openAiApiKey", message.chinalifePELoginResponse.apiKey)
					}
				} else if (message.chinalifePELoginResponse?.requiresInviteCode) {
					setIsLoggingIn(false)
					// 需要邀请码，显示输入框
					setShowInviteCodeDialog(true)
				} else {
					setIsLoggingIn(false)
					setIsSubmittingInviteCode(false)
					const errorMsg = message.chinalifePELoginResponse?.error || t("settings:providers.chinalifePELogin.loginFailed")
					setLoginErrorMessage(errorMsg)
					if (!message.chinalifePELoginResponse?.requiresInviteCode) {
						setShowInviteCodeDialog(false)
					}
				}
				break
			}
		}
	}, [setApiConfigurationField])

	useEvent("message", onMessage)

	// 初始化 openAiBaseUrl 默认值
	useEffect(() => {
		if (apiConfiguration && !apiConfiguration.openAiBaseUrl) {
			setApiConfigurationField("openAiBaseUrl", "https://ai.chinalifepe.com")
		}
	}, [apiConfiguration, setApiConfigurationField])

	useDebounce(
		() => {
			if (apiConfiguration?.openAiBaseUrl && apiConfiguration?.openAiApiKey) {
				vscode.postMessage({
					type: "requestChinalifePEModels",
					values: {
						baseUrl: apiConfiguration?.openAiBaseUrl,
						apiKey: apiConfiguration?.openAiApiKey,
					},
				})
			}
		},
		500,
		[apiConfiguration?.openAiBaseUrl, apiConfiguration?.openAiApiKey],
	)

	return (
		<div className="w-full">
			<VSCodeTextField
				value={apiConfiguration?.openAiBaseUrl || "https://ai.chinalifepe.com"}
				type="url"
				onInput={handleInputChange("openAiBaseUrl")}
				placeholder="https://ai.chinalifepe.com"
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.chinalifePEBaseUrl")}</label>
			</VSCodeTextField>
			{fromWelcomeView && !apiConfiguration?.openAiApiKey && (
				<>
					<div className="mb-4 w-full">
						<div className="flex flex-col gap-3">
							<VSCodeTextField
								value={username}
								type="text"
								onInput={(e: any) => setUsername(e.target.value)}
								placeholder={t("settings:providers.chinalifePELogin.username")}
								className="w-full">
								<label className="block font-medium mb-1">{t("settings:providers.chinalifePELogin.username")}</label>
							</VSCodeTextField>
							<VSCodeTextField
								value={password}
								type="password"
								onInput={(e: any) => setPassword(e.target.value)}
								placeholder={t("settings:providers.chinalifePELogin.password")}
								className="w-full">
								<label className="block font-medium mb-1">{t("settings:providers.chinalifePELogin.password")}</label>
							</VSCodeTextField>
							<VSCodeButton 
								onClick={handleLogin} 
								appearance="primary"
								disabled={isLoggingIn}>
								{isLoggingIn ? t("settings:providers.chinalifePELogin.loggingIn") : t("settings:providers.chinalifePELogin.login")}
							</VSCodeButton>
							{loginErrorMessage && (
								<div className="text-vscode-errorForeground text-sm">{loginErrorMessage}</div>
							)}
						</div>
					</div>
					{/* 邀请码输入对话框 */}
					<Modal isOpen={showInviteCodeDialog} onClose={() => {}} className="max-w-md h-auto">
						<div className="p-6 flex flex-col gap-4">
							<h3 className="text-lg font-semibold">{t("settings:providers.chinalifePELogin.inviteCodeDialogTitle")}</h3>
							<VSCodeTextField
								value={inviteCode}
								type="text"
								onInput={(e: any) => setInviteCode(e.target.value)}
								placeholder={t("settings:providers.chinalifePELogin.inviteCode")}
								className="w-full"
								onKeyDown={(e: any) => {
									if (e.key === "Enter" && inviteCode.trim() && username.trim() && password.trim()) {
										handleSubmitInviteCode()
									}
								}}>
							</VSCodeTextField>
							{loginErrorMessage && <div className="text-vscode-errorForeground text-sm">{loginErrorMessage}</div>}
							<div className="flex gap-2 justify-end">
								<VSCodeButton
									onClick={() => {
										setShowInviteCodeDialog(false)
										setInviteCode("")
										setLoginErrorMessage(undefined)
									}}
									appearance="secondary">
									{t("settings:providers.chinalifePELogin.cancel")}
								</VSCodeButton>
								<VSCodeButton
									onClick={handleSubmitInviteCode}
									appearance="primary"
									disabled={!inviteCode.trim() || !username.trim() || !password.trim() || isSubmittingInviteCode}>
									{isSubmittingInviteCode ? t("settings:providers.chinalifePELogin.submitting") : t("settings:providers.chinalifePELogin.submit")}
								</VSCodeButton>
							</div>
						</div>
					</Modal>
				</>
			)}
			{((!fromWelcomeView) || (fromWelcomeView && apiConfiguration?.openAiApiKey)) && (
				<VSCodeTextField
					value={apiConfiguration?.openAiApiKey || ""}
					type="password"
					onInput={handleInputChange("openAiApiKey")}
					placeholder={t("settings:placeholders.apiKey")}
					className="w-full mb-4">
					<label className="block font-medium mb-1">{t("settings:providers.chinalifePEApiKey")}</label>
				</VSCodeTextField>
			)}
			{apiConfiguration && apiConfiguration?.openAiApiKey && (
				<ModelPicker
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={setApiConfigurationField}
					defaultModelId={chinalifePEDefaultModelId}
					models={chinalifePEModels}
					modelIdKey="openAiModelId"
					serviceName="ChinalifePE"
					serviceUrl="https://ai.chinalifepe.com"
					organizationAllowList={organizationAllowList}
					errorMessage={modelValidationError}
				/>
			)}

			{/* 当选择自定义模型时，显示 OpenAI Compatible 的选项（排除 Azure） */}
			{isCustomModel && (
				<>
					<R1FormatSetting
						onChange={handleInputChange("openAiR1FormatEnabled", noTransform)}
						openAiR1FormatEnabled={apiConfiguration?.openAiR1FormatEnabled ?? false}
					/>
					<div>
						<Checkbox
							checked={openAiLegacyFormatSelected}
							onChange={(checked: boolean) => {
								setOpenAiLegacyFormatSelected(checked)
								setApiConfigurationField("openAiLegacyFormat", checked)
							}}>
							{t("settings:providers.useLegacyFormat")}
						</Checkbox>
					</div>
					<Checkbox
						checked={apiConfiguration?.openAiStreamingEnabled ?? true}
						onChange={handleInputChange("openAiStreamingEnabled", noTransform)}>
						{t("settings:modelInfo.enableStreaming")}
					</Checkbox>
					<div>
						<Checkbox
							checked={apiConfiguration?.includeMaxTokens ?? true}
							onChange={handleInputChange("includeMaxTokens", noTransform)}>
							{t("settings:includeMaxOutputTokens")}
						</Checkbox>
						<div className="text-sm text-vscode-descriptionForeground ml-6">
							{t("settings:includeMaxOutputTokensDescription")}
						</div>
					</div>

					{/* Custom Headers UI */}
					<div className="mb-4">
						<div className="flex justify-between items-center mb-2">
							<label className="block font-medium">{t("settings:providers.customHeaders")}</label>
							<StandardTooltip content={t("settings:common.add")}>
								<VSCodeButton appearance="icon" onClick={handleAddCustomHeader}>
									<span className="codicon codicon-add"></span>
								</VSCodeButton>
							</StandardTooltip>
						</div>
						{!customHeaders.length ? (
							<div className="text-sm text-vscode-descriptionForeground">
								{t("settings:providers.noCustomHeaders")}
							</div>
						) : (
							customHeaders.map(([key, value], index) => (
								<div key={index} className="flex items-center mb-2">
									<VSCodeTextField
										value={key}
										className="flex-1 mr-2"
										placeholder={t("settings:providers.headerName")}
										onInput={(e: any) => handleUpdateHeaderKey(index, e.target.value)}
									/>
									<VSCodeTextField
										value={value}
										className="flex-1 mr-2"
										placeholder={t("settings:providers.headerValue")}
										onInput={(e: any) => handleUpdateHeaderValue(index, e.target.value)}
									/>
									<StandardTooltip content={t("settings:common.remove")}>
										<VSCodeButton appearance="icon" onClick={() => handleRemoveCustomHeader(index)}>
											<span className="codicon codicon-trash"></span>
										</VSCodeButton>
									</StandardTooltip>
								</div>
							))
						)}
					</div>

					<div className="flex flex-col gap-1">
						<Checkbox
							checked={apiConfiguration?.enableReasoningEffort ?? false}
							onChange={(checked: boolean) => {
								setApiConfigurationField("enableReasoningEffort", checked)

								if (!checked && apiConfiguration) {
									const { reasoningEffort: _, ...openAiCustomModelInfo } =
										apiConfiguration.openAiCustomModelInfo || openAiModelInfoSaneDefaults

									setApiConfigurationField("openAiCustomModelInfo", openAiCustomModelInfo)
								}
							}}>
							{t("settings:providers.setReasoningLevel")}
						</Checkbox>
						{!!apiConfiguration?.enableReasoningEffort && apiConfiguration && (
							<ThinkingBudget
								apiConfiguration={{
									...apiConfiguration,
									reasoningEffort: apiConfiguration.openAiCustomModelInfo?.reasoningEffort,
								}}
								setApiConfigurationField={(field, value) => {
									if (field === "reasoningEffort" && apiConfiguration) {
										const openAiCustomModelInfo =
											apiConfiguration.openAiCustomModelInfo || openAiModelInfoSaneDefaults

										setApiConfigurationField("openAiCustomModelInfo", {
											...openAiCustomModelInfo,
											reasoningEffort: value as ReasoningEffort,
										})
									}
								}}
								modelInfo={{
									...(apiConfiguration.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
									supportsReasoningEffort: true,
								}}
							/>
						)}
					</div>
					<div className="flex flex-col gap-3">
						<div className="text-sm text-vscode-descriptionForeground whitespace-pre-line">
							{t("settings:providers.customModel.capabilities")}
						</div>

						<div>
							<VSCodeTextField
								value={
									apiConfiguration?.openAiCustomModelInfo?.maxTokens?.toString() ||
									openAiModelInfoSaneDefaults.maxTokens?.toString() ||
									""
								}
								type="text"
								style={{
									borderColor: (() => {
										const value = apiConfiguration?.openAiCustomModelInfo?.maxTokens

										if (!value) {
											return "var(--vscode-input-border)"
										}

										return value > 0 ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)"
									})(),
								}}
								onInput={handleInputChange("openAiCustomModelInfo", (e) => {
									const value = parseInt((e.target as HTMLInputElement).value)

									return {
										...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
										maxTokens: isNaN(value) ? undefined : value,
									}
								})}
								placeholder={t("settings:placeholders.numbers.maxTokens")}
								className="w-full">
								<label className="block font-medium mb-1">
									{t("settings:providers.customModel.maxTokens.label")}
								</label>
							</VSCodeTextField>
							<div className="text-sm text-vscode-descriptionForeground">
								{t("settings:providers.customModel.maxTokens.description")}
							</div>
						</div>

						<div>
							<VSCodeTextField
								value={
									apiConfiguration?.openAiCustomModelInfo?.contextWindow?.toString() ||
									openAiModelInfoSaneDefaults.contextWindow?.toString() ||
									""
								}
								type="text"
								style={{
									borderColor: (() => {
										const value = apiConfiguration?.openAiCustomModelInfo?.contextWindow

										if (!value) {
											return "var(--vscode-input-border)"
										}

										return value > 0 ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)"
									})(),
								}}
								onInput={handleInputChange("openAiCustomModelInfo", (e) => {
									const value = (e.target as HTMLInputElement).value
									const parsed = parseInt(value)

									return {
										...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
										contextWindow: isNaN(parsed) ? openAiModelInfoSaneDefaults.contextWindow : parsed,
									}
								})}
								placeholder={t("settings:placeholders.numbers.contextWindow")}
								className="w-full">
								<label className="block font-medium mb-1">
									{t("settings:providers.customModel.contextWindow.label")}
								</label>
							</VSCodeTextField>
							<div className="text-sm text-vscode-descriptionForeground">
								{t("settings:providers.customModel.contextWindow.description")}
							</div>
						</div>

						<div>
							<div className="flex items-center gap-1">
								<Checkbox
									checked={apiConfiguration?.openAiCustomModelInfo?.supportsImages ?? false}
									onChange={handleInputChange("openAiCustomModelInfo", (checked) => {
										return {
											...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
											supportsImages: checked,
										}
									})}>
									<span className="font-medium">
										{t("settings:providers.customModel.imageSupport.label")}
									</span>
								</Checkbox>
								<StandardTooltip content={t("settings:providers.customModel.imageSupport.description")}>
									<i
										className="codicon codicon-info text-vscode-descriptionForeground"
										style={{ fontSize: "12px" }}
									/>
								</StandardTooltip>
							</div>
							<div className="text-sm text-vscode-descriptionForeground pt-1">
								{t("settings:providers.customModel.imageSupport.description")}
							</div>
						</div>

						<div>
							<div className="flex items-center gap-1">
								<Checkbox
									checked={apiConfiguration?.openAiCustomModelInfo?.supportsPromptCache ?? false}
									onChange={handleInputChange("openAiCustomModelInfo", (checked) => {
										return {
											...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
											supportsPromptCache: checked,
										}
									})}>
									<span className="font-medium">{t("settings:providers.customModel.promptCache.label")}</span>
								</Checkbox>
								<StandardTooltip content={t("settings:providers.customModel.promptCache.description")}>
									<i
										className="codicon codicon-info text-vscode-descriptionForeground"
										style={{ fontSize: "12px" }}
									/>
								</StandardTooltip>
							</div>
							<div className="text-sm text-vscode-descriptionForeground pt-1">
								{t("settings:providers.customModel.promptCache.description")}
							</div>
						</div>

						<div>
							<VSCodeTextField
								value={
									apiConfiguration?.openAiCustomModelInfo?.inputPrice?.toString() ??
									openAiModelInfoSaneDefaults.inputPrice?.toString() ??
									""
								}
								type="text"
								style={{
									borderColor: (() => {
										const value = apiConfiguration?.openAiCustomModelInfo?.inputPrice

										if (!value && value !== 0) {
											return "var(--vscode-input-border)"
										}

										return value >= 0 ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)"
									})(),
								}}
								onChange={handleInputChange("openAiCustomModelInfo", (e) => {
									const value = (e.target as HTMLInputElement).value
									const parsed = parseFloat(value)

									return {
										...(apiConfiguration?.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
										inputPrice: isNaN(parsed) ? openAiModelInfoSaneDefaults.inputPrice : parsed,
									}
								})}
								placeholder={t("settings:placeholders.numbers.inputPrice")}
								className="w-full">
								<div className="flex items-center gap-1">
									<label className="block font-medium mb-1">
										{t("settings:providers.customModel.pricing.input.label")}
									</label>
									<StandardTooltip content={t("settings:providers.customModel.pricing.input.description")}>
										<i
											className="codicon codicon-info text-vscode-descriptionForeground"
											style={{ fontSize: "12px" }}
										/>
									</StandardTooltip>
								</div>
							</VSCodeTextField>
						</div>

						<div>
							<VSCodeTextField
								value={
									apiConfiguration?.openAiCustomModelInfo?.outputPrice?.toString() ||
									openAiModelInfoSaneDefaults.outputPrice?.toString() ||
									""
								}
								type="text"
								style={{
									borderColor: (() => {
										const value = apiConfiguration?.openAiCustomModelInfo?.outputPrice

										if (!value && value !== 0) {
											return "var(--vscode-input-border)"
										}

										return value >= 0 ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)"
									})(),
								}}
								onChange={handleInputChange("openAiCustomModelInfo", (e) => {
									const value = (e.target as HTMLInputElement).value
									const parsed = parseFloat(value)

									return {
										...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
										outputPrice: isNaN(parsed) ? openAiModelInfoSaneDefaults.outputPrice : parsed,
									}
								})}
								placeholder={t("settings:placeholders.numbers.outputPrice")}
								className="w-full">
								<div className="flex items-center gap-1">
									<label className="block font-medium mb-1">
										{t("settings:providers.customModel.pricing.output.label")}
									</label>
									<StandardTooltip content={t("settings:providers.customModel.pricing.output.description")}>
										<i
											className="codicon codicon-info text-vscode-descriptionForeground"
											style={{ fontSize: "12px" }}
										/>
									</StandardTooltip>
								</div>
							</VSCodeTextField>
						</div>

						{apiConfiguration?.openAiCustomModelInfo?.supportsPromptCache && (
							<>
								<div>
									<VSCodeTextField
										value={apiConfiguration?.openAiCustomModelInfo?.cacheReadsPrice?.toString() ?? "0"}
										type="text"
										style={{
											borderColor: (() => {
												const value = apiConfiguration?.openAiCustomModelInfo?.cacheReadsPrice

												if (!value && value !== 0) {
													return "var(--vscode-input-border)"
												}

												return value >= 0
													? "var(--vscode-charts-green)"
													: "var(--vscode-errorForeground)"
											})(),
										}}
										onChange={handleInputChange("openAiCustomModelInfo", (e) => {
											const value = (e.target as HTMLInputElement).value
											const parsed = parseFloat(value)

											return {
												...(apiConfiguration?.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
												cacheReadsPrice: isNaN(parsed) ? 0 : parsed,
											}
										})}
										placeholder={t("settings:placeholders.numbers.inputPrice")}
										className="w-full">
										<div className="flex items-center gap-1">
											<span className="font-medium">
												{t("settings:providers.customModel.pricing.cacheReads.label")}
											</span>
											<StandardTooltip
												content={t("settings:providers.customModel.pricing.cacheReads.description")}>
												<i
													className="codicon codicon-info text-vscode-descriptionForeground"
													style={{ fontSize: "12px" }}
												/>
											</StandardTooltip>
										</div>
									</VSCodeTextField>
								</div>
								<div>
									<VSCodeTextField
										value={apiConfiguration?.openAiCustomModelInfo?.cacheWritesPrice?.toString() ?? "0"}
										type="text"
										style={{
											borderColor: (() => {
												const value = apiConfiguration?.openAiCustomModelInfo?.cacheWritesPrice

												if (!value && value !== 0) {
													return "var(--vscode-input-border)"
												}

												return value >= 0
													? "var(--vscode-charts-green)"
													: "var(--vscode-errorForeground)"
											})(),
										}}
										onChange={handleInputChange("openAiCustomModelInfo", (e) => {
											const value = (e.target as HTMLInputElement).value
											const parsed = parseFloat(value)

											return {
												...(apiConfiguration?.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
												cacheWritesPrice: isNaN(parsed) ? 0 : parsed,
											}
										})}
										placeholder={t("settings:placeholders.numbers.cacheWritePrice")}
										className="w-full">
										<div className="flex items-center gap-1">
											<label className="block font-medium mb-1">
												{t("settings:providers.customModel.pricing.cacheWrites.label")}
											</label>
											<StandardTooltip
												content={t("settings:providers.customModel.pricing.cacheWrites.description")}>
												<i
													className="codicon codicon-info text-vscode-descriptionForeground"
													style={{ fontSize: "12px" }}
												/>
											</StandardTooltip>
										</div>
									</VSCodeTextField>
								</div>
							</>
						)}

						<Button
							variant="secondary"
							onClick={() => setApiConfigurationField("openAiCustomModelInfo", openAiModelInfoSaneDefaults)}>
							{t("settings:providers.customModel.resetDefaults")}
						</Button>
					</div>
				</>
			)}
		</div>
	)
}

