/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from 'vs/base/common/event';
import { IReference } from 'vs/base/common/lifecycle';
import * as paths from 'vs/base/common/path';
import { isEqual, joinPath } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { PLAINTEXT_LANGUAGE_ID } from 'vs/editor/common/languages/modesRegistry';
import { IResolvedTextEditorModel, ITextModelService } from 'vs/editor/common/services/resolverService';
import { IFileDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { EditorInputCapabilities, GroupIdentifier, ISaveOptions, IUntypedEditorInput } from 'vs/workbench/common/editor';
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { IInteractiveDocumentService } from 'vs/workbench/contrib/interactive/browser/interactiveDocumentService';
import { IInteractiveHistoryService } from 'vs/workbench/contrib/interactive/browser/interactiveHistoryService';
import { IResolvedNotebookEditorModel } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { ICompositeNotebookEditorInput, NotebookEditorInput } from 'vs/workbench/contrib/notebook/common/notebookEditorInput';
import { INotebookService } from 'vs/workbench/contrib/notebook/common/notebookService';

export class InteractiveEditorInput extends EditorInput implements ICompositeNotebookEditorInput {
	static create(instantiationService: IInstantiationService, resource: URI, inputResource: URI, title?: string, language?: string) {
		return instantiationService.createInstance(InteractiveEditorInput, resource, inputResource, title, language);
	}

	static readonly ID: string = 'workbench.input.interactive';

	public override get editorId(): string {
		return 'interactive';
	}

	override get typeId(): string {
		return InteractiveEditorInput.ID;
	}

	private _initTitle?: string;

	get language() {
		return this._inputModelRef?.object.textEditorModel.getLanguageId() ?? this._initLanguage;
	}
	private _initLanguage?: string;

	private _notebookEditorInput: NotebookEditorInput;
	get notebookEditorInput() {
		return this._notebookEditorInput;
	}

	get editorInputs() {
		return [this._notebookEditorInput];
	}

	private _resource: URI;

	override get resource(): URI {
		return this._resource;
	}

	private _inputResource: URI;

	get inputResource() {
		return this._inputResource;
	}
	private _inputResolver: Promise<IResolvedNotebookEditorModel | null> | null;
	private _editorModelReference: IResolvedNotebookEditorModel | null;

	private _inputModelRef: IReference<IResolvedTextEditorModel> | null;

	get primary(): EditorInput {
		return this._notebookEditorInput;
	}
	private _textModelService: ITextModelService;
	private _interactiveDocumentService: IInteractiveDocumentService;
	private _historyService: IInteractiveHistoryService;


	constructor(
		resource: URI,
		inputResource: URI,
		title: string | undefined,
		languageId: string | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
		@ITextModelService textModelService: ITextModelService,
		@IInteractiveDocumentService interactiveDocumentService: IInteractiveDocumentService,
		@IInteractiveHistoryService historyService: IInteractiveHistoryService,
		@INotebookService private readonly _notebookService: INotebookService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService
	) {
		const input = NotebookEditorInput.create(instantiationService, resource, 'interactive', {});
		super();
		this._notebookEditorInput = input;
		this._register(this._notebookEditorInput);
		this._initTitle = title;
		this._initLanguage = languageId;
		this._resource = resource;
		this._inputResource = inputResource;
		this._inputResolver = null;
		this._editorModelReference = null;
		this._inputModelRef = null;
		this._textModelService = textModelService;
		this._interactiveDocumentService = interactiveDocumentService;
		this._historyService = historyService;

		this._registerListeners();
	}

	private _registerListeners(): void {
		const oncePrimaryDisposed = Event.once(this.primary.onWillDispose);
		this._register(oncePrimaryDisposed(() => {
			if (!this.isDisposed()) {
				this.dispose();
			}
		}));

		// Re-emit some events from the primary side to the outside
		this._register(this.primary.onDidChangeDirty(() => this._onDidChangeDirty.fire()));
		this._register(this.primary.onDidChangeLabel(() => this._onDidChangeLabel.fire()));

		// Re-emit some events from both sides to the outside
		this._register(this.primary.onDidChangeCapabilities(() => this._onDidChangeCapabilities.fire()));
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Untitled
			| EditorInputCapabilities.Readonly
			| EditorInputCapabilities.Scratchpad;
	}

	private async _resolveEditorModel() {
		if (!this._editorModelReference) {
			this._editorModelReference = await this._notebookEditorInput.resolve();
		}

		return this._editorModelReference;
	}

	override async resolve(): Promise<IResolvedNotebookEditorModel | null> {
		if (this._editorModelReference) {
			return this._editorModelReference;
		}

		if (this._inputResolver) {
			return this._inputResolver;
		}

		this._inputResolver = this._resolveEditorModel();

		return this._inputResolver;
	}

	async resolveInput(language?: string) {
		if (this._inputModelRef) {
			return this._inputModelRef.object.textEditorModel;
		}

		const resolvedLanguage = language ?? this._initLanguage ?? PLAINTEXT_LANGUAGE_ID;
		this._interactiveDocumentService.willCreateInteractiveDocument(this.resource!, this.inputResource, resolvedLanguage);
		this._inputModelRef = await this._textModelService.createModelReference(this.inputResource);

		return this._inputModelRef.object.textEditorModel;
	}

	override async save(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IUntypedEditorInput | undefined> {
		if (this._editorModelReference) {

			if (this.hasCapability(EditorInputCapabilities.Untitled)) {
				return this.saveAs(group, options);
			} else {
				await this._editorModelReference.save(options);
			}

			return this;
		}

		return undefined;
	}

	override async saveAs(group: GroupIdentifier, options?: ISaveOptions): Promise<IUntypedEditorInput | undefined> {
		if (!this._editorModelReference) {
			return undefined;
		}

		const provider = this._notebookService.getContributedNotebookType('interactive');

		if (!provider) {
			return undefined;
		}

		const pathCandidate = joinPath(await this._fileDialogService.defaultFilePath(), 'scratch.ipynb');

		const target = await this._fileDialogService.pickFileToSave(pathCandidate, options?.availableFileSystems);
		if (!target) {
			return undefined; // save cancelled
		}

		return await this._editorModelReference.saveAs(target);
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(otherInput)) {
			return true;
		}
		if (otherInput instanceof InteractiveEditorInput) {
			return isEqual(this.resource, otherInput.resource) && isEqual(this.inputResource, otherInput.inputResource);
		}
		return false;
	}

	override getName() {
		if (this._initTitle) {
			return this._initTitle;
		}

		const p = this.primary.resource!.path;
		const basename = paths.basename(p);

		return basename.substr(0, basename.length - paths.extname(p).length);
	}

	override dispose() {
		// we support closing the interactive window without prompt, so the editor model should not be dirty
		this._editorModelReference?.revert({ soft: true });

		this._notebookEditorInput?.dispose();
		this._editorModelReference?.dispose();
		this._editorModelReference = null;
		this._interactiveDocumentService.willRemoveInteractiveDocument(this.resource!, this.inputResource);
		this._inputModelRef?.dispose();
		this._inputModelRef = null;
		super.dispose();
	}

	get historyService() {
		return this._historyService;
	}
}
