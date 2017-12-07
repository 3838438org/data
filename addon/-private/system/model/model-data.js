import isEnabled from '../../features';
import { DEBUG } from '@glimmer/env';
import Relationships from "../relationships/state/create";
import { assign, merge } from '@ember/polyfills';
import { isEqual } from '@ember/utils';
import { assert, warn, inspect } from '@ember/debug';
import { copy } from '@ember/object/internals';
import { get } from '@ember/object';

const emberAssign = assign || merge;
export default class ModelData {
  constructor(modelName, id, clientId, storeWrapper, store, internalModel) {
    this.store = store;
    this.modelName = modelName;
    this.internalModel = internalModel;
    this.__relationships = null;
    this.__implicitRelationships = null;
    this.clientId = clientId;
    this.id = id;
  }

  // PUBLIC API

  getResourceIdentifier() {
    return {
      id: this.id,
      type: this.modelName,
      clientId: this.clientId
    }
  }

  linkWasLoadedForRelationship(key, data) {
    // only belongsTo for now
    if (data) {
      // TODO IGOR deal with null
      let newInternalModel = this.store._internalModelForResource(data);
      this._relationships.get(key).addInternalModel(newInternalModel);
    }
  }

  setupData(data, calculateChange) {
    let changedKeys;

    if (calculateChange) {
      changedKeys = this._changedKeys(data.attributes);
    }

    emberAssign(this._data, data.attributes);
    if (this.internalModel.hasRecord && this.__attributes) {
      // only do this if we are materialized and we have attribute changes
      this._updateChangedAttributes();
    }

    if (data.relationships) {
      this._setupRelationships(data);
    }
    if (data.id) {
      this.id = data.id;
    }

    return changedKeys;
  }

  adapterWillCommit() {
    this._inFlightAttributes = this._attributes;
    this._attributes = null;
  }

  hasChangedAttributes() {
    return this.__attributes !== null && Object.keys(this.__attributes).length > 0;
  }

  // TODO, Maybe can model as destroying model data?
  resetRecord() {
    this.__attributes = null;
    this.__inFlightAttributes = null;
    this._data = null;
  }

  addToHasMany(key, modelDatas, idx) {
    this._relationships.get(key).addInternalModels(modelDatas.map((model) => model.internalModel), idx);
  }

  removeFromHasMany(key, modelDatas) {
    this._relationships.get(key).removeInternalModels(modelDatas.map((model) => model.internalModel));
  }

  _setupRelationships(data) {
    let internalModel = this.internalModel;
    internalModel.type.eachRelationship((relationshipName, descriptor) => {
      if (!data.relationships[relationshipName]) {
        return;
      }
      // in debug, assert payload validity eagerly
      let relationshipData = data.relationships[relationshipName];
      if (DEBUG) {
        let relationshipMeta = get(this.internalModel.type, 'relationshipsByName').get(relationshipName);
        if (!relationshipData || !relationshipMeta) {
          return;
        }

        if (relationshipData.links) {
          let isAsync = relationshipMeta.options && relationshipMeta.options.async !== false;
          warn(`You pushed a record of type '${internalModel.type.modelName}' with a relationship '${relationshipName}' configured as 'async: false'. You've included a link but no primary data, this may be an error in your payload.`, isAsync || relationshipData.data , {
            id: 'ds.store.push-link-for-sync-relationship'
          });
        } else if (relationshipData.data) {
          if (relationshipMeta.kind === 'belongsTo') {
            assert(`A ${internalModel.type.modelName} record was pushed into the store with the value of ${relationshipName} being ${inspect(relationshipData.data)}, but ${relationshipName} is a belongsTo relationship so the value must not be an array. You should probably check your data payload or serializer.`, !Array.isArray(relationshipData.data));
          } else if (relationshipMeta.kind === 'hasMany') {
            assert(`A ${internalModel.type.modelName} record was pushed into the store with the value of ${relationshipName} being '${inspect(relationshipData.data)}', but ${relationshipName} is a hasMany relationship so the value must be an array. You should probably check your data payload or serializer.`, Array.isArray(relationshipData.data));
          }
        }
      }
      let relationship = this._relationships.get(relationshipName);
      relationship.push(relationshipData);
    });
  }

  /*
    Checks if the attributes which are considered as changed are still
    different to the state which is acknowledged by the server.

    This method is needed when data for the internal model is pushed and the
    pushed data might acknowledge dirty attributes as confirmed.

    @method updateChangedAttributes
    @private
   */
  _updateChangedAttributes() {
    let changedAttributes = this.changedAttributes();
    let changedAttributeNames = Object.keys(changedAttributes);
    let attrs = this._attributes;

    for (let i = 0, length = changedAttributeNames.length; i < length; i++) {
      let attribute = changedAttributeNames[i];
      let data = changedAttributes[attribute];
      let oldData = data[0];
      let newData = data[1];

      if (oldData === newData) {
        delete attrs[attribute];
      }
    }
  }

  /*
    Returns an object, whose keys are changed properties, and value is an
    [oldProp, newProp] array.

    @method changedAttributes
    @private
  */
  changedAttributes() {
    let oldData = this._data;
    let currentData = this._attributes;
    let inFlightData = this._inFlightAttributes;
    let newData = emberAssign(copy(inFlightData), currentData);
    let diffData = Object.create(null);
    let newDataKeys = Object.keys(newData);

    for (let i = 0, length = newDataKeys.length; i < length; i++) {
      let key = newDataKeys[i];
      diffData[key] = [oldData[key], newData[key]];
    }

    return diffData;
  }

  rollbackAttributes() {
    let dirtyKeys;
    if (this.hasChangedAttributes()) {
      dirtyKeys = Object.keys(this._attributes);
      this._attributes = null;
    }

    if (get(this.internalModel, 'isError')) {
      this._inFlightAttributes = null;
      // TODO IGOR DAVID seems bad to have to go back, maybe move to internalModel?
      this.internalModel.didCleanError();
    }

    if (this.internalModel.isNew()) {
      this.removeFromInverseRelationships(true);
    }

    if (this.internalModel.isValid()) {
      this._inFlightAttributes = null;
    }

    return dirtyKeys;
  }

  adapterDidCommit(data) {
    if (data) {
      // this.store._internalModelDidReceiveRelationshipData(this.modelName, this.id, data.relationships);
      if (data.relationships) {
        this._setupRelationships(data);
      }
      data = data.attributes;
    }
    let changedKeys = this._changedKeys(data);

    emberAssign(this._data, this._inFlightAttributes);
    if (data) {
      emberAssign(this._data, data);
    }

    this._inFlightAttributes = null;

    this._updateChangedAttributes();
    return changedKeys;
  }

  getHasMany(key) {
    return this._relationships.get(key).getRecords();
  }

  setHasMany(key, records) {
    let relationship = this._relationships.get(key);
    relationship.clear();
    relationship.addInternalModels(records.map(record => get(record, '_internalModel')));
  }

  saveWasRejected() {
    let keys = Object.keys(this._inFlightAttributes);
    if (keys.length > 0) {
      let attrs = this._attributes;
      for (let i=0; i < keys.length; i++) {
        if (attrs[keys[i]] === undefined) {
          attrs[keys[i]] = this._inFlightAttributes[keys[i]];
        }
      }
    }
    this._inFlightAttributes = null;
  }

  getBelongsTo(key) {
    return this._relationships.get(key).getData();
  }

  setBelongsTo(key, value) {
    if (value && value.then) {
      this._relationships.get(key).setRecordPromise(value);
    } else if (value) {
      this._relationships.get(key).setInternalModel(value._internalModel);
    } else {
      this._relationships.get(key).setInternalModel(value);
    }
  }

  setAttr(key, value) {
    let originalValue;
    // Add the new value to the changed attributes hash
    this._attributes[key] = value;

    if (key in this._inFlightAttributes) {
      originalValue = this._inFlightAttributes[key];
    } else {
      originalValue = this._data[key];
    }
    // If we went back to our original value, we shouldn't keep the attribute around anymore
    if (value === originalValue) {
      delete this._attributes[key];
    }
  }

  getAttr(key) {
    if (key in this._attributes) {
      return this._attributes[key];
    } else if (key in this._inFlightAttributes) {
      return this._inFlightAttributes[key];
    } else {
      return this._data[key];
    }
  }

  hasAttr(key) {
    return key in this._attributes ||
         key in this._inFlightAttributes ||
         key in this._data;
  }

  isAttrDirty(key) {
    if (this._attributes[key] === undefined) {
      return false;
    }
    let originalValue;
    if (this._inFlightAttributes[key] !== undefined) {
      originalValue = this._inFlightAttributes[key];
    } else {
      originalValue = this._data[key];
    }

    return originalValue !== this._attributes[key];
  }

  get _attributes() {
    if (this.__attributes === null) {
      this.__attributes = Object.create(null);
    }
    return this.__attributes;
  }

  set _attributes(v) {
    this.__attributes = v;
  }

  get _relationships() {
    if (this.__relationships === null) {
      this.__relationships = new Relationships(this);
    }

    return this.__relationships;
  }

  get _data() {
    if (this.__data === null) {
      this.__data = Object.create(null);
    }
    return this.__data;
  }

  set _data(v) {
    this.__data = v;
  }

  /*
   implicit relationships are relationship which have not been declared but the inverse side exists on
   another record somewhere
   For example if there was

   ```app/models/comment.js
   import DS from 'ember-data';

   export default DS.Model.extend({
   name: DS.attr()
   })
   ```

   but there is also

   ```app/models/post.js
   import DS from 'ember-data';

   export default DS.Model.extend({
   name: DS.attr(),
   comments: DS.hasMany('comment')
   })
   ```

   would have a implicit post relationship in order to be do things like remove ourselves from the post
   when we are deleted
  */
  get _implicitRelationships() {
    if (this.__implicitRelationships === null) {
      this.__implicitRelationships = Object.create(null);
    }
    return this.__implicitRelationships;
  }

  get _inFlightAttributes() {
    if (this.__inFlightAttributes === null) {
      this.__inFlightAttributes = Object.create(null);
    }
    return this.__inFlightAttributes;
  }

  set _inFlightAttributes(v) {
    this.__inFlightAttributes = v;
  }

  /*


    TODO IGOR AND DAVID this shouldn't be public
   This method should only be called by records in the `isNew()` state OR once the record
   has been deleted and that deletion has been persisted.

   It will remove this record from any associated relationships.

   If `isNew` is true (default false), it will also completely reset all
    relationships to an empty state as well.

    @method removeFromInverseRelationships
    @param {Boolean} isNew whether to unload from the `isNew` perspective
    @private
   */
  removeFromInverseRelationships(isNew = false) {
    this._relationships.forEach((name, rel) => {
      rel.removeCompletelyFromInverse();
      if (isNew === true) {
        rel.clear();
      }
    });

    let implicitRelationships = this._implicitRelationships;
    this.__implicitRelationships = null;

    Object.keys(implicitRelationships).forEach((key) => {
      let rel = implicitRelationships[key];

      rel.removeCompletelyFromInverse();
      if (isNew === true) {
        rel.clear();
      }
    });
  }

  // TODO IGOR AND DAVID this shouldn't be public
  destroyRelationships() {
    let relationships = this._relationships;
    relationships.forEach((name, rel) => destroyRelationship(rel));

    let implicitRelationships = this._implicitRelationships;
    this.__implicitRelationships = null;
    Object.keys(implicitRelationships).forEach((key) => {
      let rel = implicitRelationships[key];

      destroyRelationship(rel);

      rel.destroy();
    });
  }


  // TODO IGOR AND DAVID REFACTOR THIS
  didCreateLocally(properties) {
    // TODO @runspired this should also be coalesced into some form of internalModel.setState()
    this.internalModel.eachRelationship((key, descriptor) => {
      if (properties[key] !== undefined) {
        this._relationships.get(key).setHasData(true);
      }
    });
  }


  /*
    Ember Data has 3 buckets for storing the value of an attribute on an internalModel.

    `_data` holds all of the attributes that have been acknowledged by
    a backend via the adapter. When rollbackAttributes is called on a model all
    attributes will revert to the record's state in `_data`.

    `_attributes` holds any change the user has made to an attribute
    that has not been acknowledged by the adapter. Any values in
    `_attributes` are have priority over values in `_data`.

    `_inFlightAttributes`. When a record is being synced with the
    backend the values in `_attributes` are copied to
    `_inFlightAttributes`. This way if the backend acknowledges the
    save but does not return the new state Ember Data can copy the
    values from `_inFlightAttributes` to `_data`. Without having to
    worry about changes made to `_attributes` while the save was
    happenign.


    Changed keys builds a list of all of the values that may have been
    changed by the backend after a successful save.

    It does this by iterating over each key, value pair in the payload
    returned from the server after a save. If the `key` is found in
    `_attributes` then the user has a local changed to the attribute
    that has not been synced with the server and the key is not
    included in the list of changed keys.



    If the value, for a key differs from the value in what Ember Data
    believes to be the truth about the backend state (A merger of the
    `_data` and `_inFlightAttributes` objects where
    `_inFlightAttributes` has priority) then that means the backend
    has updated the value and the key is added to the list of changed
    keys.

    @method _changedKeys
    @private
  */
  /*
      TODO IGOR DAVID
      There seems to be a potential bug here, where we will return keys that are not
      in the schema
  */
  _changedKeys(updates) {
    let changedKeys = [];

    if (updates) {
      let original, i, value, key;
      let keys = Object.keys(updates);
      let length = keys.length;
      let hasAttrs = this.hasChangedAttributes();
      let attrs;
      if (hasAttrs) {
        attrs= this._attributes;
      }

      original = emberAssign(Object.create(null), this._data);
      original = emberAssign(original, this._inFlightAttributes);

      for (i = 0; i < length; i++) {
        key = keys[i];
        value = updates[key];

        // A value in _attributes means the user has a local change to
        // this attributes. We never override this value when merging
        // updates from the backend so we should not sent a change
        // notification if the server value differs from the original.
        if (hasAttrs === true && attrs[key] !== undefined) {
          continue;
        }

        if (!isEqual(original[key], value)) {
          changedKeys.push(key);
        }
      }
    }

    return changedKeys;
  }
}

if (isEnabled('ds-rollback-attribute')) {
  /*
     Returns the latest truth for an attribute - the canonical value, or the
     in-flight value.

     @method lastAcknowledgedValue
     @private
  */
  ModelData.prototype.lastAcknowledgedValue = function lastAcknowledgedValue(key) {
    if (key in this._inFlightAttributes) {
      return this._inFlightAttributes[key];
    } else {
      return this._data[key];
    }
  };
}

function destroyRelationship(rel) {
  if (rel._inverseIsAsync()) {
    rel.removeInternalModelFromInverse(rel.inverseInternalModel);
    rel.removeInverseRelationships();
  } else {
    rel.removeCompletelyFromInverse();
  }
}