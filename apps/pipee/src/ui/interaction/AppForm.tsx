import { FieldApi, createFormHook, createFormHookContexts, useSelector } from "@tanstack/react-form"
import { useEffect } from "react"

const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts()

export const { useAppForm, withForm, withFieldGroup } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {},
  formComponents: {},
})

export { useFieldContext, useFormContext }
export { useSelector as useFormSelector }

export const useFormSentinel = (form: object, name: string): void => {
  useEffect(() => {
    const field = new FieldApi({ form: form as never, name: name as never })
    return field.mount()
  }, [form, name])
}
