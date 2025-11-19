import { useCallback, useState, useEffect } from "react"
import knuthShuffle from "knuth-shuffle-seeded"
import { Trans } from "react-i18next"
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import posthog from "posthog-js"

import type { ProviderSettings } from "@roo-code/types"
import { chinalifePEDefaultModelId } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { validateApiConfiguration } from "@src/utils/validate"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"

import ApiOptions from "../settings/ApiOptions"
import { Tab, TabContent } from "../common/Tab"

import RooHero from "./RooHero"

const WelcomeView = () => {
	const { apiConfiguration, currentApiConfigName, setApiConfiguration, uriScheme, machineId} = useExtensionState()
	const { t } = useAppTranslation()
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
	const [showRooProvider, setShowRooProvider] = useState(false)

	// Check PostHog feature flag for Roo provider
	useEffect(() => {
		posthog.onFeatureFlags(function () {
			setShowRooProvider(posthog?.getFeatureFlag("roo-provider-featured") === "test")
		})
	}, [])

	// Memoize the setApiConfigurationField function to pass to ApiOptions
	const setApiConfigurationFieldForApiOptions = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => {
			setApiConfiguration({ [field]: value })
		},
		[setApiConfiguration], // setApiConfiguration from context is stable
	)


	const handleSubmit = useCallback(() => {
		const error = apiConfiguration ? validateApiConfiguration(apiConfiguration) : undefined

		if (error) {
			setErrorMessage(error)
			return
		}

		setErrorMessage(undefined)
		vscode.postMessage({ type: "upsertApiConfiguration", text: currentApiConfigName, apiConfiguration })
	}, [apiConfiguration, currentApiConfigName])

	// Using a lazy initializer so it reads once at mount
	const [imagesBaseUri] = useState(() => {
		const w = window as any
		return w.IMAGES_BASE_URI || ""
	})

	// Initialize apiConfiguration with defaultApiConfig if it's not set
	useEffect(() => {
		if (!apiConfiguration?.apiProvider) {
			setApiConfiguration({ 
				apiProvider: 'chinalifepe',
				openAiModelId: chinalifePEDefaultModelId,
				openAiBaseUrl: 'https://ai.chinalifepe.com',
			});
		}
	}, []);

	return (
		<Tab>
			<TabContent className="flex flex-col gap-4 p-6 items-center">
				<RooHero />
				<h2 className="mt-0 mb-4 text-xl text-center">{t("welcome:greeting")}</h2>

				<div className="text-base text-vscode-foreground py-2 px-2 mb-4">
					<p className="mb-3 leading-relaxed">
						<Trans i18nKey="welcome:introduction" />
					</p>
					<p className="mb-0 leading-relaxed">
						<Trans i18nKey="welcome:chooseProvider" />
					</p>
				</div>

				<div className="mb-4 w-full">
					<ApiOptions
						fromWelcomeView
						apiConfiguration={apiConfiguration || {}}
						uriScheme={uriScheme}
						setApiConfigurationField={setApiConfigurationFieldForApiOptions}
						errorMessage={errorMessage}
						setErrorMessage={setErrorMessage}
					/>
				</div>
			</TabContent>

			<div className="sticky bottom-0 bg-vscode-sideBar-background p-4 border-t border-vscode-panel-border">
				<div className="flex flex-col gap-2">
					<div className="flex justify-end">
						<VSCodeLink
							href="#"
							onClick={(e) => {
								e.preventDefault()
								vscode.postMessage({ type: "importSettings" })
							}}
							className="text-sm">
							{t("welcome:importSettings")}
						</VSCodeLink>
					</div>
					<VSCodeButton 
						onClick={handleSubmit} 
						appearance="primary"
						disabled={!apiConfiguration?.openAiApiKey}>
						{t("welcome:start")}
					</VSCodeButton>

				</div>
			</div>
		</Tab>
	)
}

export default WelcomeView
