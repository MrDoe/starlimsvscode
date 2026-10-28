// https://davidwalsh.name/pubsub-javascript
// better implementation in bridge-middleLayer.js - Soon this will be replaced
/*XFD-SANDBOX-PATCH*/var XfdCommonControlsPubSub = (function () {
	var topics = {};
	var hOP = topics.hasOwnProperty;

	return {
		subscribe: function (topic, listener) {
			// Create the topic's object if not yet created
			if(!hOP.call(topics, topic)) topics[topic] = [];

			// Add the listener to queue
			var index = topics[topic].push(listener) - 1;

			// Provide handle back for removal of topic
			return {
				remove: function () {
					delete topics[topic][index];
				}
			};
		},
		publish: function (topic, info) {
			//var realTopic = window.PubSub.pubSubConfig[topic];

			// If the topic doesn't exist, or there's no listeners in queue, just leave
			if(!hOP.call(topics, topic)) return;

			// Cycle through topics queue, fire!
			topics[topic].forEach(function (item) {
				//was sending {} when info null causing issues for subscribers
				//item(info  != undefined ? info : {});
				if(typeof item === 'function')
					item(info);
				//object
				else if(typeof item === 'object') {
					var member = item.member;
					var thisArg = item.this;

					//function call
					if(typeof member === 'function')
						member.call(thisArg, info);
					//property set
					else
						//ViewController property
						if(thisArg.isViewController)
							thisArg[member] = info;
						else
							//ViewModel field
							if(thisArg.isViewModel)
								thisArg.set(member, info);
							else
								//View config
								if(thisArg.isComponent)
									thisArg.config[member] = info;
				}
			});
		}
		//	subscribeOnce : function(topic, listener) {
		//			// Create the topic's object if not yet created
		//			if(!topics[topic]) topics[topic] = { queue: [] };
		//
		//			// Add the listener to queue
		//			var index = topics[topic].queue.push(function(data){
		//					listener(data);
		//					delete topics[topic].queue[index];
		//				}) -1;
		//
		//			// Provide handle back for removal of topic
		//			return {
		//				remove: function() {
		//					delete topics[topic].queue[index];
		//				}
		//			};
		//		}
	};
/*XFD-SANDBOX-PATCH*/})(); try { if (window.top !== window) { void window.top.PubSub; } window.top.PubSub = XfdCommonControlsPubSub; } catch (xfdE) { if (!(window.PubSub && typeof window.PubSub.subscribe === "function")) { window.PubSub = XfdCommonControlsPubSub; } }

//This allows attributing a tabIndex to table views.
Ext.override(Ext.view.Table, {
	onFocusEnter: function () {
		if(this.$doNotOverrideFocusEvent)
			var currentTabIndex = this.el.dom.tabIndex;

		this.callOverridden(arguments);
        if (this.focusEl) { //bug in plate control if you clicked in the plate before it is drawn Z00002053B0166
            this.focusEl.dom.setAttribute('tabIndex', this.tabIndex || -1);

            //restore it
            if (this.$doNotOverrideFocusEvent)
                this.el.dom.setAttribute('tabIndex', currentTabIndex);
        }
	},
	onFocusLeave: function () {
		if(this.$doNotOverrideFocusEvent)
			var currentTabIndex = this.el.dom.tabIndex;

		this.callOverridden(arguments);
		this.focusEl.dom.setAttribute('tabIndex', this.tabIndex || 0);

		//restore it
		if(this.$doNotOverrideFocusEvent)
			this.el.dom.setAttribute('tabIndex', currentTabIndex);
	}
});

// add another event to the check-box : beforecheck with a single parameter : the checkBox itself.
// if the event is not defined - the framework returns - true - by default - so the this.callPrent(...) will be executed (default behaviour).
Ext.override(Ext.form.field.Checkbox, {
	onBoxClick: function () {
		if(!this.fireEvent('beforecheck', this)) return;
		return this.callParent(arguments);
	}
});


// include also the value 'Y' in the list that will check a checkbox @ bind time
Ext.override(Ext.form.field.Checkbox, {
	isChecked: function (rawValue, inputValue) {
		return (rawValue === true || rawValue === 'true' || rawValue === '1' || rawValue === 1 || rawValue === 'Y' || (((Ext.isString(rawValue) || Ext.isNumber(rawValue)) && inputValue) ? rawValue == inputValue : this.onRe.test(rawValue)));
	}
});


//Ext.override(Ext.grid.column.Check, {
Ext.define('Starlims.Controls.grid.checkColumn', {
	extend: 'Ext.grid.column.Check',
	xtype: 'starlimsCheckColumn',

	stopSelection: false,

	defaultRenderer: function (value, cellValues) {
		if(typeof value == 'string')
			value = value == 'Y' ? true : false;

		var cssPrefix = Ext.baseCSSPrefix,
			cls = cssPrefix + 'grid-checkcolumn';
		if(this.disabled) {
			cellValues.tdCls += ' ' + this.disabledCls;
		}
		if(value) {
			cls += ' ' + cssPrefix + 'grid-checkcolumn-checked';
		}
		return '<div class="' + cls + '" role="button" tabIndex="0"></div>';
	},

	isRecordChecked: function (record) {
		var prop = this.property;
		if(prop) {
			return record[prop];
		}

		if(typeof record.get(this.dataIndex) == 'string')
			return record.get(this.dataIndex) === 'Y' ? true : false;
		else
			return record.get(this.dataIndex);
	},

	setRecordCheck: function (record, checked, cell, row, e) {
		var me = this,
			prop = me.property;
		if(prop) {
			record[prop] = checked;
			me.updater(cell, checked);
		} else {
			var storedData = record.get(me.dataIndex);
			if(typeof storedData == 'string')
				record.set(me.dataIndex, checked ? 'Y' : 'N');
			else
				record.set(me.dataIndex, checked); // we are implying boolean value

			// if we got here it means that the user directly clicked on the check box (w/o the row edit in place)

			// get the host grid
			var grid = me.up('grid'),
				plugin = grid.getPlugin('airowediting'),
				simpleColumn = null;

			if(plugin) {
				grid.headerCt.getVisibleGridColumns().some(function (column, index, array) {
					simpleColumn = column;
					return column.getXType() === 'gridcolumn';
				});

				if(simpleColumn) { // found a column
					// select the checked row first ... so we can set the active item - line 190684: column = me.activeField.column;
					grid.getSelectionModel().select(record);
					plugin.startEdit(record, simpleColumn);
				}
			}
			else {
				// raise event on the store to synch data
				if(me.callServer === true) // if you want to update the new value automatically ...
					record.store.fireEvent('onUpdateProvider', grid.getItemId() || grid.getReference() || grid.getId());
			}
		}
	},

	updater: function (cell, value) {
		cell = Ext.fly(cell);
		cell[this.disabled ? 'addCls' : 'removeCls'](this.disabledCls);

		if(typeof value === 'string')
			value = value === 'Y' ? true : false;
		Ext.fly(cell.down(this.getView().innerSelector, true).firstChild)[value ? 'addCls' : 'removeCls'](Ext.baseCSSPrefix + 'grid-checkcolumn-checked');
	}
});

Ext.define('Starlims.Controls.udtextbox', {
	extend: 'Ext.form.field.Text',

	xtype: 'udtextbox',
	enableKeyEvents: true,

	triggers: {
		ellipses: {
			cls: 'fa-ellipsis-h'
		}
	},

	listeners: {
		keydown: function (textField, e, eOpts) {
			if(e.keyCode != 9) // if it's not TAB (or shift-tab) - so we can navigate with the keys.
				e.preventDefault();
		}
	},

	initComponent: function () {
		var me = this;
		me.triggers.ellipses.handler = me.click;
		me.callParent();
	}
});

Ext.define('Starlims.Controls.editdeletetextbox', {
	extend: 'Ext.form.field.Text',

	xtype: 'editdeletetextbox',
	enableKeyEvents: true,

	triggers: {
		edit: {
			cls: 'fa-pencil-square',
			width: '24px'
		},
		elipsesv: {
			cls: 'fa-ellipsis-v',
			width: '5px'
		},
		del: {
			cls: 'fa-times',
			width: '24px'
		}
	},

	listeners: {
		keydown: function (textField, e, eOpts) {
			if(e.keyCode != 9) // if it's not TAB (or shift-tab) - so we can navigate with the keys.
				e.preventDefault();
		}
	},

	initComponent: function () {
		var me = this;
		me.triggers.edit.handler = me.edit;
		me.triggers.del.handler = me.delete;
		me.callParent();
	}
});

//region commonpopup
/********************************************************************************
Description.. :	Common Popup
Configs...... : See View definition Configs below
Author....... :	BOGDAN
Date......... : 2016-08-17  		
********************************************************************************
Example Usage:
********************************************************************************/
//region View
Ext.define('Starlims.Controls.commonpopup', {
	extend: 'Ext.window.Window',
	xtype: 'common-popup',

	cls: 'common-popup', // needed for the mouseClick event in the update provider implementation
	reference: 'common-popup',

	autoShow: true,
	constrain: true,
	modal: true,
	height: 400,
	width: 450,

	layout: 'fit',

	// change the text/visibility of the buttons :
	//addButtonText: '',
	//okButtonText: '',
	//cancelButtonText:'',
	config: {
		closePopup: true, // set this value to false so the window will NOT be closed by the common-popup controller
		okButtonVisible: true,
		cancelButtonVisible: true,
		addButtonVisible: false
	},

	buttons: [
		{
			text: 'Add',
			itemId: 'addFormButton',
			reference: 'addFormButton',
			scale: 'medium',
			minWidth: 100,
			hidden: true,
			listeners: {
				click: 'positiveOnClick',
				focus: function (button, event, eOpts) {
					Ext.ComponentQuery.query('#saveFormButton')[0].setTabIndex(0);
				}
			}
		},
		{
			text: 'Save',
			itemId: 'saveFormButton',
			reference: 'saveFormButton',
			scale: 'medium',
			minWidth: 100,
			listeners: {
				click: 'positiveOnClick',
				focus: function (button, event, eOpts) {
					Ext.ComponentQuery.query('#cancelFormButton')[0].setTabIndex(0);
				}
			}
		}, {
			text: 'Cancel',
			itemId: 'cancelFormButton',
			reference: 'cancelFormButton',
			scale: 'medium',
			minWidth: 100,
			listeners: {
				click: 'negativeOnClick',
				blur: function (button, event, eOpts) {
					window.setTimeout(function () {
						var saveBtn = Ext.ComponentQuery.query('#saveFormButton')[0];
						if(saveBtn) // when cancel is clicked the window closes and destroys the button
							saveBtn.setTabIndex(0);
					}, 100);
				}
			}
		}],

	initComponent: function () {
		var me = this;

		var form = {
			xtype: 'form',
			//modelValidation: true,

			border: false,
			bodyPadding: 5,

			layout: 'anchor',

			defaultType: 'textfield',
			defaults: {
				msgTarget: 'side', // under
				anchor: '100%'
			}
		};

		if(me.formConfiguration)
			Ext.apply(form, me.formConfiguration);

		form.items = me.items;
		me.items = form;

		if(!me.getController())
			me.setController(Ext.create('Ext.app.ViewController'));
		Ext.applyIf(me.getController(), Ext.create('Starlims.Controls.commonpopupViewController'));

		me.callParent();

		// change buttons text
		var addButton = me.lookupReference('addFormButton');
		if(me.getAddButtonVisible())
			addButton.setHidden(!me.getAddButtonVisible());
		if(me.addButtonText)
			addButton.setText(me.addButtonText);

		var okButton = me.lookupReference('saveFormButton');
		if(!me.getOkButtonVisible())
			okButton.setHidden(!me.getOkButtonVisible());
		else
			if(me.okButtonText) okButton.setText(me.okButtonText);

		var cancelButton = me.lookupReference('cancelFormButton');
		if(!me.getCancelButtonVisible())
			cancelButton.setHidden(!me.getCancelButtonVisible());
		else
			if(me.cancelButtonText) cancelButton.setText(me.cancelButtonText);

		me.on('afterrender', '_validatePopup', me.getController());
	}
});
//endregion

//region Controller
Ext.define('Starlims.Controls.commonpopupViewController', {
	extend: 'Ext.app.ViewController',
	alias: 'controller.commonPopUpWindow',

	positiveOnClick: function (button, e, eOpts) {
		var me = this,
			innerForm = me._findForm(),
			view = me.getView(),
			validInput = true;

		validInput = me._validateInput();

		if(validInput) {
			var eventSource = view.eventSource || view;

			var bClose = (button.reference == 'saveFormButton');
			eventSource.fireEvent('positive', view, bClose);

			// make sure that the view was not closed in the positive handler 
			if(view && view.getClosePopup())
				view.close();
		}
	},

	negativeOnClick: function (button, e, eOpts) {
		var me = this,
			view = me.getView(),
			eventSource = view.eventSource || view;

		eventSource.fireEvent('negative', view);

		// make sure that the view was not closed in the positive handler 
		if(view && (view.getClosePopup() || !view.hasListener('negative')))
			view.close();
	},

	_findForm: function () {
		var form = this.getView();

		while(form.down('form') != null) {
			form = form.down('form');
			return form;
		}

		return form;
	},

	_validateInput: function () {
		var me = this,
			valid = true,
			errors = [],
			formView = me._findForm(),
			models = formView.getViewModel() ?
				formView.getViewModel().getData() :
				(me.getViewModel() ?
					me.getViewModel().getData() :
					null); // if the form does not have any model attached ...

		if(models) {
			var formValues = formView.getValues();
			Ext.iterate(models, function (key, keyValue) {
				if(keyValue instanceof Ext.data.Model) {
					me._syncModelValues(keyValue, formValues);

					if(!keyValue.isValid()) {
						valid = false;
						Ext.iterate(keyValue.getValidation().getData(), function (field, value) {
							if(value != true)
								errors.push({ field: field, message: value });
						});
					}
				}
			});
		}

		if(!valid)
			formView.getForm().markInvalid(errors);

		return valid;
	},

	_syncModelValues: function (model, formValues) {
		var me = this;

		Ext.iterate(model.getData(), function (field, value) {
			if(formValues.hasOwnProperty(field) && formValues[field] !== value)
				model.set(field, formValues[field]);
		});
	},

	_getAllItems: function _getAllItems(container) {
		/*Get children of passed panel or an empty array if it doesn't have thems.*/
		var children = container.items ? container.items.items : [];
		/*For each child get their children and concatenate to result.*/
		Ext.each(children, function (child) {
			children = children.concat(_getAllItems(child));
		})
		return children;
	},


	_validatePopup: function () {
		var me = this,
			view = me.getView(),
			form = me._findForm(),
			viewModels = me.getViewModel() ? me.getViewModel().getData() : null,
			message = '',
			modelNames = [],
			fieldNames = [];

		if(!view.eventSource)
			message += 'eventSource property is missing \r';

		// get all the field names form the validation attached to the form view.
		Ext.iterate(viewModels, function (key, keyValue) {
			if(keyValue instanceof Ext.data.Model)
				Ext.iterate(keyValue.getValidation().getData(), function (field, value) {
					modelNames.push(field);
				});
		});

		var formItems = me._getAllItems(form);

		// get the names of all the fields from the form
		formItems.forEach(function (item, index, arrayLen) {
			if(item.name)
				fieldNames.push(item.name);
		});

		// make sure that all the names from the validation appears as names in the fields;
		modelNames.forEach(function (modelElement, modelIndex, modelArray) {
			//if (fieldNames.findIndex(function (fieldElement, fieldIndex, fieldArray) {
			//	return (fieldElement == modelElement)
			//}) < 0)

			if(fieldNames.indexOf(modelElement) < 0)
				message += 'The validation ' + modelElement + ' is missing from the field names \r';
		})

		if(message)
			console.log(message);
	}
});
//endregion
//endregion

Ext.define('Starlims.Controls.commonwizard', {
	extend: 'Ext.window.Window',

	xtype: 'common-wizard',
	controller: 'common-wizard',
	cls: 'common-wizard', // needed for the mouseClick event in the update provider implementation

	layout: {
		type: 'card',
		deferredRender: true
	},

	autoShow: true,
	constrain: true,
	modal: true,
	title: 'Generic Wizard',

	height: 400,
	minHeight: 150,
	width: 650,
	minWidth: 320,

	imageSrc: 'RUNTIME_SUPPORT.GetImageById.lims?ImageId=BC5DF163-EEC8-A747-80F2-128909D7E690',

	buttons: [{
		text: 'Previous',
		itemId: 'prevButton',
		reference: 'prevButton',
		scale: 'medium',
		disabled: true,
		minWidth: 100,
		listeners: {
			click: 'previousOnClick',
			focus: function () {
				Ext.ComponentQuery.query('#nextButton')[0].setTabIndex(0);
			}
		}
	}, {
		text: 'Next',
		itemId: 'nextButton',
		reference: 'nextButton',
		scale: 'medium',
		minWidth: 100,
		listeners: {
			click: 'nextOnClick',
			focus: function () {
				Ext.ComponentQuery.query('#cancelButton')[0].setTabIndex(0);
			}
		}
	}, {
		text: 'Cancel',
		itemId: 'cancelButton',
		reference: 'cancelButton',
		scale: 'medium',
		minWidth: 100,
		listeners: {
			click: 'cancelOnClick',
			blur: function () {
				window.setTimeout(function () {
					var prevBtn = Ext.ComponentQuery.query('#prevButton')[0];
					if(prevBtn) // when cancel is clicked the window closes and distroys the button
						prevBtn.setTabIndex(0);
				}, 100);
			}
		}
	}],

	_addFormCard: function (card, index) {
		var me = this,
			cardReference = Ext.String.format('__card{0}', index);

		Ext.apply(card, { flex: 8, itemId: cardReference, header: false, wizard: (function () { return me; })() });

		return {
			xtype: 'container',
			cardReference: cardReference,
			reference: '__container' + cardReference,
			itemId: '__container' + cardReference,
			layout: {
				type: 'hbox',
				align: 'stretch'
			},

			items: [{
				xtype: 'image',
				reference: '__image' + cardReference,
				itemId: '__image' + cardReference,
				alt: 'wizard image',
				flex: 2
			},
				card]
		};
	},

	getCard: function (cardName) {
		return this.lookupReference(cardName);
	},

	getAllCards: function () {
		return this._allCards;
	},

	getVisitedCards: function () {
		var me = this,
			visited = [];
		Ext.iterate(me._visitedCards, function (key, value) {
			visited.push(value);
		})

		return visited;
	},

	wasCardVisited: function (cardReferenceName) {

		if(!cardReferenceName) return false;

		var me = this,
			result = false,
			visitedCards = me.getVisitedCards();

		if(visitedCards && visitedCards.length > 0)
			result = visitedCards.some(function (element, index, array) {
				return element._wizardForm.getReference() == cardReferenceName;
			});

		return result;
	},

	initComponent: function () {
		var me = this;

		if(!me.items) me.items = [];
		me._allCards = [];
		me._visitedCards = {};
		me._visited = [];

		if(!me.wizardCards)
			console.log('no cards are present!');
		else {
			Ext.iterate(me.wizardCards, function (key, value) {
				me.items.push(me._addFormCard(key, value));
			});
		}

		me.callParent();

		// add buttons to the view (instead of lookupReference ... )
		me._prevButton = me.lookupReference('prevButton');
		if(me.prevButtonText) me._prevButton.setText(me.prevButtonText);

		me._nextButton = me.lookupReference('nextButton');
		if(me.nextButtonText) me._nextButton.setText(me.nextButtonText);

		me._cancelButton = me.lookupReference('cancelButton');
		if(me.cancelButtonText) me._cancelButton.setText(me.cancelButtonText);

		// add images and references to the wizard
		for(var i = 0; i < me.wizardCards.length; i++) {
			var referenceName = Ext.String.format('__card{0}', i),
				containerRef = Ext.String.format('__container{0}', referenceName),
				imageRef = Ext.String.format('__image{0}', referenceName);

			var cardContainer = me.lookupReference(containerRef);
			cardContainer._wizardImage = me.lookupReference(imageRef);
			cardContainer._wizardForm = cardContainer.down('#' + referenceName);  // me.lookupReference(referenceName);

			// get the image component:
			cardContainer._wizardImage.setSrc(cardContainer._wizardForm.imageSrc || me.imageSrc);

			// add each of the card to an array so we can return it from the getAllCards function
			me._allCards.push(cardContainer);
		}

		Ext.Function.interceptAfter(me.getLayout(), 'setActiveItem', function (nextItem) {
			if(nextItem)
				nextItem._wizardForm.fireEvent('cardActivated');
		});



		// try to focus first textbox
		//var firstFocus = me.down('[cls=required]'); // css class
		//if (firstFocus && firstFocus.focus)
		//	firstFocus.focus(false, 300);
	}
});
Ext.define('Starlims.Controls.commonwizardViewController', {
	extend: 'Ext.app.ViewController',
	alias: 'controller.common-wizard',

	init: function () {
		var me = this,
			layout = me.getView().getLayout();

		// if you want that the first view to be different than the view with index 0
		// then set the first card as being the .firstView or the card with index 0 (zero).
		var firstCardIndex = me.getView().firstViewIndex || 0;

		layout.setActiveItem(me.getView()._allCards[firstCardIndex]);
		me._setWizardTitle();
	},

	previousOnClick: function (button, e, eOpts) {
		var me = this,
			view = me.getView(),
			layout = view.getLayout();

		layout.setActiveItem(me._getFromVisited());

		// make sure that is not the last one
		button.setDisabled(layout.getPrev() === false);

		// set the text for finish
		view._nextButton.setText('Next').isFinish = false;

		me._setWizardTitle();
	},

	nextOnClick: function (button, e, eOpts) {
		var me = this,
			view = me.getView(),
			layout = view.getLayout(),
			currentActiveItem = layout.getActiveItem(),
			nextActiveItem = null;

		// validate cutrrent item
		if(!me._validateView.apply(currentActiveItem._wizardForm))
			return;

		view._prevButton.setDisabled(false);

		// we will create another list of visited cards that will be returned
		// for getVisitedCards function
		view._visitedCards[currentActiveItem.getReference()] = currentActiveItem;


		if(button.isFinish) {
			var me = this,
				view = me.getView();
			var eventSource = view.eventSource || view;
			eventSource.fireEvent('positive', view);

			// make sure that the view was not closed in the positive handler 
			if(view)
				view.close();

			return;
		}
		else {
			// add to the stack of visited
			me._addToVisited(currentActiveItem);

			// determine the next item - this will be a object {reference: 'refereceOfTheNextItem', isLast: true/false}
			// if - reference is missing the next item in the list will be selected
			// if - isLast is missing then we will NOT change the status of the button to .isFinish = true and the text to 'Finish'
			var nextItem = currentActiveItem._wizardForm.nextActiveItem;
			if(nextItem) {
				if(nextItem.reference) {
					nextActiveItem = view.lookupReference(nextItem.reference);
					var containerRef = '__container' + nextActiveItem.getItemId();
					nextActiveItem = view.lookupReference(containerRef);
				}
			}

			if(!nextActiveItem)
				nextActiveItem = layout.getNext();

			layout.setActiveItem(nextActiveItem);

			if(!layout.getNext() || (nextItem && nextItem.isLast)) {
				button.setText('Finish');
				button.isFinish = true;
			}
		}
		me._setWizardTitle();
	},

	cancelOnClick: function (button, e, eOpts) {
		var me = this,
			view = me.getView();
		var eventSource = view.eventSource || view;
		eventSource.fireEvent('negative', view);
		this.getView().close();
	},

	_addToVisited: function (activeView) {
		this.getView()._visited.push(activeView);
	},

	_getFromVisited: function () {
		return this.getView()._visited.pop();
	},

	_validateView: function () {
		var me = this,
			valid = true,
			errors = [],
			formView = me, // the function is called on the _wizardForm
			models = me.getViewModel() ? me.getViewModel().getData() : null;

		if(models)
			Ext.iterate(models, function (key, keyValue) {
				if((keyValue instanceof Ext.data.Model) && !keyValue.isValid()) {
					valid = false;
					Ext.iterate(keyValue.getValidation().getData(), function (field, value) {
						if(value != true)
							errors.push({ field: field, message: value });
					});
				}
			});

		if(!valid)
			formView.getForm().markInvalid(errors);
		else
			//Additional validations for current view
			//if (errors.length == 0)
			valid = formView.fireEvent('cardValidated');

		return valid;
	},

	_setWizardTitle: function () {
		var me = this,
			view = me.getView(),
			activeItem = view.getLayout().getActiveItem();

		view.setTitle(activeItem._wizardForm.getTitle() || view.getTitle());
	}
});

Ext.define('Starlims.Controls.grid.selectFirstRecord', {
	extend: 'Ext.plugin.Abstract',
	alias: 'plugin.aiselectfirstrecord',
	pluginId: 'aiselectfirstrecord',

	init: function (cmp) {
		this.setCmp(cmp);
		var theGrid = this.getCmp();

		// get the name of the bind - the name of hte store that is bound to the grid
		var storeName = theGrid.getBind().store.stub.name;
		// get the store object
		var boundStore = theGrid.getBind().store.owner.get(storeName);
		// get ready when the store loads 		
		boundStore.on('load', this.gridStoreLoaded, theGrid);
	},

	gridStoreLoaded: function (store, records, successful, operation, eOpts) {

		if(!records || records.length == 0) return;

		var firstRecord = records[0];
		if(!firstRecord) return;

		var me = this;

		// select the first record
		me.getSelectionModel().select(firstRecord);


		//set the record in edit mode - in case of row editing plugin present;

		// are we using row editing ? airowediting
		var rowEditing = me.getPlugin('airowediting');
		var rowSelect = me.getPlugin('aiselectfirstrecord');

		if(rowEditing && rowSelect.enterEditMode) {
			var simpleColumn = null;
			me.headerCt.getVisibleGridColumns().some(function (column, index, array) {
				simpleColumn = column;
				return column.getXType() === 'gridcolumn';
			});

			if(simpleColumn) // found a column
				rowEditing.startEdit(firstRecord, simpleColumn);
		}
	}
});