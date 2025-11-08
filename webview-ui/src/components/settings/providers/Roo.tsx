import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { type ProviderSettings, type OrganizationAllowList, rooDefaultModelId } from "@roo-code/types"

import type { RouterModels } from "@roo/api"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

import { ModelPicker } from "../ModelPicker"

type RooProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	cloudIsAuthenticated: boolean
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
}

export const Roo = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	cloudIsAuthenticated,
	organizationAllowList,
	modelValidationError,
}: RooProps) => {
	const { t } = useAppTranslation()

	return (
		<>
			{/* Hidden: Roo Code Cloud authentication */}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={rooDefaultModelId}
				models={routerModels?.roo ?? {}}
				modelIdKey="apiModelId"
				serviceName="Roo"
				serviceUrl="https://roocode.com"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
			/>
		</>
	)
}
