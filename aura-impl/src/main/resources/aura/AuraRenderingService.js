/*
 * Copyright (C) 2013 salesforce.com, inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * @class The Aura Rendering Service, accessible using <code>$A.renderingService</code>.
 *        Renders components. The default behaviors can be customized in a
 *        client-side renderer.
 * @constructor
 * @export
 */
function AuraRenderingService() {
    this.visited = undefined;
    this.afterRenderStack = [];
    this.dirtyComponents = {};
    // KRIS: HALO: HACK:
    // IE11 is not returning the Object.keys() for dirtyComponents in the order they were added.
    // So we rerender dirty out of order.
    // This array assures we rerender in the order that we add keys to the array.
    // Ideally, we shouldn't care what order we rerender in, but that's a more difficult bug to track down in 194/patch
    this.dirtyComponentIds = [];
    this.needsCleaning = false;
    this.markerToReferencesMap = {};
    this.rerenderFacetTopVisit = true;

    // For elements that do not have a data-aura-rendered-by attribute, we'll add a unique identifier.
    this.DATA_UID_KEY = "data-rendering-service-uid";
    this.uid = 1;
}

/**
 * Renders a component by calling its renderer.
 *
 * @param {Component}
 *            components The component or component array to be rendered
 * @param {Component}
 *            parent Optional. The component's parent
 * @memberOf AuraRenderingService
 * @public
 * @export
 */
AuraRenderingService.prototype.render = function(components, parent) {
    //#if {"modes" : ["STATS"]}
    var startTime = (new Date()).getTime();
    //#end

    components = this.getArray(components);
    var elements = [];

    for (var i=0; i < components.length; i++){
        var cmp = components[i];

        if (!$A.util.isComponent(cmp)) {
            if ($A.componentService.isComponentDefRef(cmp)) {
                // If someone passed a config in, construct it.
                cmp = $A.componentService.createComponentPriv(cmp);
                // And put the constructed component back into the array.
                components[i] = cmp;
            } else {
                $A.warning("AuraRenderingService.render: 'component[" + i + "]' was not a valid component, found '" + cmp + "'.");
                continue;
            }
        }

        if (cmp.isValid()) {
            $A.clientService.setCurrentAccess(cmp);
            try {
                var renderedElements = cmp["render"]();
                renderedElements = this.finishRender(cmp, renderedElements);
                elements = elements.concat(renderedElements);
            } catch (e) {
                if (e instanceof $A.auraError && e["component"]) {
                    throw e;
                } else {
                    var ae = new $A.auraError("render threw an error in '" + cmp.getType() + "'", e);
                    $A.lastKnownError = ae;
                    throw ae;
                }
            } finally {
                $A.clientService.releaseCurrentAccess();
            }
        }
    }

    if (parent) {
        $A.util.appendChild(elements, parent);
    }

    //#if {"modes" : ["STATS"]}
    this.statsIndex["render"].push({
        'component' : components,
        'startTime' : startTime,
        'endTime' : (new Date()).getTime()
    });
    //#end

    return elements;
};

/**
 * The default rerenderer for components affected by an event. Call
 * superRerender() from your customized function to chain the
 * rerendering to the components in the body attribute.
 *
 * @param {Component}
 *            components The component or component array to be rerendered
 * @memberOf AuraRenderingService
 * @public
 * @export
 */
AuraRenderingService.prototype.rerender = function(components) {
    //#if {"modes" : ["STATS"]}
    var startTime = Date.now();
    //#end

    var topVisit = false;
    var visited = this.visited;
    if (!visited) {
        visited = this.visited = {};
        topVisit = true;
    }

    var elements = [];

    components = this.getArray(components);
    for (var i = 0; i < components.length; i++) {
        var cmp = components[i];
        var id = cmp.getGlobalId();
        if (cmp.isValid()) {
            var renderedElements = [];
            var addExistingElements = visited[id];
            if (!visited[id]) {
                if (!cmp.isRendered()) {
                    throw new $A.auraError("Aura.RenderingService.rerender: attempt to rerender component that has not been rendered.", null, $A.severity.QUIET);
                }
                var rerenderedElements = undefined;
                $A.clientService.setCurrentAccess(cmp);
                try {
                    rerenderedElements = cmp["rerender"]();
                } catch (e) {
                    if (e instanceof $A.auraError && e["component"]) {
                        throw e;
                    } else {
                        var ae = new $A.auraError("rerender threw an error in '" + cmp.getType() + "'", e);
                        $A.lastKnownError = ae;
                        throw ae;
                    }
                } finally {
                    $A.clientService.releaseCurrentAccess();
                    if(rerenderedElements!=undefined){//eslint-disable-line eqeqeq
                        renderedElements=renderedElements.concat(rerenderedElements);
                    }else{
                        addExistingElements=true;
                    }
                }
                visited[id] = true;
            }
            if(addExistingElements){
                renderedElements=renderedElements.concat(this.getElements(cmp));
            }
            elements=elements.concat(renderedElements);
        }
        this.cleanComponent(id);
    }
    //#if {"modes" : ["STATS"]}
    this.statsIndex["rerender"].push({
        'component' : components,
        'startTime' : startTime,
        'endTime' : Date.now()
    });
    //#end

    if (topVisit) {
        this.visited = undefined;
        try {
            this.afterRender(this.afterRenderStack);
        } finally {
            this.afterRenderStack.length = 0;
        }
        for(var r=0;r<components.length;r++){
            components[r].fire("render");
        }
    }

    return elements;
};

/**
 * The default behavior after a component is rendered.
 *
 * @param {component}
 *            components The component or component array that has finished rendering
 * @memberOf AuraRenderingService
 * @public
 * @export
 */
AuraRenderingService.prototype.afterRender = function(components) {
    //#if {"modes" : ["STATS"]}
    var startTime = Date.now();
    //#end

    components = this.getArray(components);
    for(var i=0;i<components.length;i++){
        var cmp = components[i];
        if(!$A.util.isComponent(cmp)) {
            $A.warning("AuraRenderingService.afterRender: 'cmp' must be a valid Component, found '"+cmp+"'.", null, $A.severity.QUIET);
            continue;
        }
        if(cmp.isValid()) {
            $A.clientService.setCurrentAccess(cmp);
            try {
                cmp["afterRender"]();
                cmp.fire("render");
            } catch (e) {
                // The after render routine threw an error, so we should
                //  (a) log the error
                if (e instanceof $A.auraError && e["component"]) {
                    throw e;
                } else {
                    var ae = new $A.auraError("afterRender threw an error in '" + cmp.getType() + "'", e);
                    $A.lastKnownError = ae;
                    throw ae;
                }
                //  (b) mark the component as possibly broken.
                //  FIXME: keep track of component stability
            } finally {
                $A.clientService.releaseCurrentAccess(cmp);
            }
        }
    }

    //#if {"modes" : ["STATS"]}
    this.statsIndex["afterRender"].push({
        'component' : components,
        'startTime' : startTime,
        'endTime' : Date.now()
    });
    //#end
};

/**
 * The default unrenderer that deletes all the DOM nodes rendered by a
 * component's render() function. Call superUnrender() from your
 * customized function to modify the default behavior.
 *
 * @param {Component}
 *            components The component or component array to be unrendered
 * @memberOf AuraRenderingService
 * @public
 * @export
 */
AuraRenderingService.prototype.unrender = function(components) {
    if (!components) {
        return;
    }

    //#if {"modes" : ["STATS"]}
    var startTime = Date.now();
    //#end

    var visited = this.visited;
    components = this.getArray(components);

    var cmp;
    var container;
    var beforeUnrenderElements;
    for (var i = 0,length=components.length; i < length; i++){
        cmp = components[i];
        if ($A.util.isComponent(cmp) && cmp.destroyed!==1 && cmp.isRendered()) {
            cmp.setUnrendering(true);
            $A.clientService.setCurrentAccess(cmp);

            // Use the container to check if we're in the middle of unrendering a parent component.
            // Sometimes that is not available, so otherwise move to considering the owner.
            container = cmp.getContainer() || cmp.getOwner();

            // If the parent is NOT unrendering, then remove these and unrender it's children.
            // In the unrenderFacets function, those elements won't be removed from the DOM since their parents here
            // are getting removed.
            if (container && !container.getConcreteComponent().isUnrendering()) {
                // This is the top of the unrendering tree.
                // Save the elements we want to remove, so they can be deleted after the unrender is called.
                beforeUnrenderElements = cmp.getElements();
            } else {
                beforeUnrenderElements = null;
            }

            try {
                cmp["unrender"]();
            } catch (e) {
                if (e instanceof $A.auraError && e["component"]) {
                    throw e;
                } else {
                    var ae = new $A.auraError("unrender threw an error in '" + cmp.getType() + "'", e);
                    $A.lastKnownError = ae;
                    throw ae;
                }
            } finally {
                $A.clientService.releaseCurrentAccess(cmp);

                var oldContainerMarker = this.getMarker(container);
                this.removeElement(this.getMarker(cmp), container);

                var currentContainerMarker = this.getMarker(container);
                // When we remove the marker from container, we only update the references which use the marker element
                // as marker. So, in the container chain, the old marker element may still exist in the component's element
                // collection, if the element is not the marker of the component. Keeping the container chain up to date is
                // required now, because we use the first element to determine the postion when updating container chain during
                // re-rendering facet.
                if (oldContainerMarker !== currentContainerMarker) {
                    this.replaceContainerElement(container, oldContainerMarker, currentContainerMarker);
                }

                // If we have beforeUnrenderElements, then we're in a component that should have its
                // elements removed, and those elements are the ones in beforeUnrenderElements.
                if (beforeUnrenderElements && beforeUnrenderElements.length) {
                    // TODO: at the top level of unrendering tree, it's probably needed to remove beforeUnrenderElements
                    // from container chain. Otherwise, the containers may have redundant elements until they get rerendered.

                    for (var c = 0; c < beforeUnrenderElements.length; c++) {
                        $A.util.removeElement(beforeUnrenderElements[c]);
                    }
                }

                if (cmp.destroyed!==1) {
                    cmp.setRendered(false);
                    if (visited) {
                        visited[cmp.getGlobalId()] = true;
                    }
                    cmp.setUnrendering(false);
                }
            }
        }
    }

    //#if {"modes" : ["STATS"]}
    this.statsIndex["unrender"].push({
        'component' : components,
        'startTime' : startTime,
        'endTime' : Date.now()
    });
    //#end
};

/**
 * Used in AuraRenderingService.unrender to update the new marker element in the container chain.
 *
 * Do not use this method in render or re-render. It doesn't apply aura-class to the new element.
 */
AuraRenderingService.prototype.replaceContainerElement = function(container, oldElement, newElement) {
    if (!container) {
        return;
    }

    var concrete = container.getConcreteComponent();
    // stop updating elements for container chain if it is a HtmlComponent which can have body.
    // this needs to match the render logic.
    if ((concrete.getType() === "aura:html" && concrete["helper"].canHaveBody(concrete)) ||
            concrete.isRendered() === false) {
        return;
    }

    var allElements = this.getAllElements(concrete);
    var index = allElements.indexOf(oldElement);
    if (index > -1) {
        allElements[index] = newElement;

        // because this replacement only happens when container component gets a new marker during child's unrender,
        // the new element is supposed to be always comment marker
        if (!this.isCommentMarker(oldElement)) {
            var elements = this.getElements(concrete);
            index = elements.indexOf(oldElement);
            if (index > -1) {
                elements.splice(index, 1);
            }
        }
    }

    this.replaceContainerElement(concrete.getContainer(), oldElement, newElement);
};

/**
 * @private
 * @memberOf AuraRenderingService
 *
 * @param {Component} component the component for which we are storing the facet.
 * @param {Component|Array} facet the component or array of components to store.
 */
AuraRenderingService.prototype.storeFacetInfo = function(component, facet) {
    if (!$A.util.isComponent(component)) {
        throw new $A.auraError("AuraRenderingService.storeFacetInfo: 'component' must be a valid Component. Found '" + component + "'.",
                null, $A.severity.QUIET);
    }
    if ($A.util.isComponent(facet)) {
        facet=[facet];
    }
    if (!$A.util.isArray(facet)) {
        $A.warning("AuraRenderingService.storeFacetInfo: 'facet' must be a Component or an Array. Found '" + facet + "' in '" + component.getType() + "'.");
        facet = [];
    }
    component._facetInfo = facet.slice(0);
};

/**
 * @private
 * @memberOf AuraRenderingService
 */
AuraRenderingService.prototype.getUpdatedFacetInfo = function(component, facet) {
    if(!$A.util.isComponent(component)) {
        throw new $A.auraError("AuraRenderingService.getUpdatedFacetInfo: 'component' must be a valid Component. Found '" + component + "'.",
                null, $A.severity.QUIET);
    }
    if($A.util.isComponent(facet)){
        facet=[facet];
    }
    if(!$A.util.isArray(facet)){
        $A.warning("AuraRenderingService.getUpdatedFacetInfo: 'facet' must be a Component or an Array. Found '" + facet + "' in '" + component.getType() + "'.");
        facet = [];
    }
    var updatedFacet={
        components:[],
        facetInfo:[],
        useFragment:false,
        fullUnrender:false,
        hasNewMarker:false
    };
    var renderCount=0;
    if (component._facetInfo) {
        var jmax = -1; // the last matched item index
        for (var i = 0; i < facet.length; i++) {
            var child = facet[i];
            // Guard against undefined/null facets, as these will cause troubles later.
            if (child) {
                if(!$A.util.isComponent(child)) {
                    $A.warning("AuraRenderingService.getUpdatedFacetInfo: all values to be rendered in an expression must be components.  Found '" + child + "' in '" + component.getType() + "'.");
                    continue;
                }

                var found = false;
                for (var j = 0; j < component._facetInfo.length; j++) {
                    if (child === component._facetInfo[j]) {
                        updatedFacet.components.push({action:"rerender",component: child, oldIndex: j, newIndex: i});
                        // If the child is in a different position AND the order is different
                        if ((j!==(i-renderCount)) && (j < jmax)) {
                            updatedFacet.useFragment=true;
                        }
                        jmax = j;
                        found = true;
                        component._facetInfo[j] = undefined;
                        break;
                    }
                }
                if (!found) {
                    updatedFacet.components.push({action:"render",component: child, oldIndex: -1, newIndex: i});
                    // the component will have a new marker from the new rendered component
                    if (i === 0) {
                        updatedFacet.hasNewMarker = true;
                    }
                    renderCount++;
                }
                updatedFacet.facetInfo.push(child);
            }
        }
        if(!updatedFacet.components.length){
            updatedFacet.fullUnrender=true;
        }
        for (var x = 0; x < component._facetInfo.length; x++) {
            if (component._facetInfo[x]) {
                updatedFacet.components.unshift({action: "unrender",component: component._facetInfo[x], oldIndex: x, newIndex: -1});
            }
        }
    }
    return updatedFacet;
};

/**
 * @public
 * @param {Component} component the component for which we are rendering the facet.
 * @param {Component|Array} facet the facet to render.
 * @param {Component} parent (optional) the parent for the facet.
 * @export
 */
AuraRenderingService.prototype.renderFacet = function(component, facet, parent) {
    var ret = this.render(facet, parent);
    this.storeFacetInfo(component, facet);

    var containerId = component.globalId;
    var componentOnFacet;
    // facet can be a component or an array
    for (var i = 0; i < component._facetInfo.length; i++) {
        // dynamically created component uses its creator as its container when it gets created
        // the container needs to be updated when the component gets rendered
        componentOnFacet = component._facetInfo[i];
        if ($A.util.isComponent(componentOnFacet) && componentOnFacet.containerComponentId !== containerId) {
            componentOnFacet.setContainerComponentId(component.globalId);
        }
    }

    if (!ret.length) {
        if(parent) {
            this.setMarker(component, parent);
        } else {
            this.setMarker(component, ret[0]=this.createMarker(null,"render facet: " + component.getGlobalId()));
        }
    } else if(parent) {
        this.setMarker(component, parent);
    } else {
        this.setMarker(component, ret[0]);
    }
    return ret;
};

/**
 * @public
 * @param {Component} component the component for which we are rendering the facet.
 * @param {Component} facet the facet to render.
 * @param {HTMLElement} referenceNode the reference node for insertion
 * @export
 */
AuraRenderingService.prototype.rerenderFacet = function(component, facet, referenceNode) {

    var updatedFacet=this.getUpdatedFacetInfo(component,facet);
    var ret=[];
    var marker = this.getMarker(component);
    var target = referenceNode||marker.parentNode;
    var calculatedPosition = 0;
    var nextSibling = null;

    var topVisit = this.rerenderFacetTopVisit;
    var beforeRerenderElements = null;
    var oldElementContainerPositions = null;

    // for the top visit, it needs to figure out the updated elements for the dirty component
    // to update the component's container chain
    if (topVisit) {
        this.rerenderFacetTopVisit = false;
        beforeRerenderElements = this.getAllElementsCopy(component);
        // the positions are needed when updating elements on the containers, because if a component is unrendered
        // during rerender, the marker element will be updated when moving marker's references.
        oldElementContainerPositions = this.findElementsPositionFromContainers(component);
    }

    // If the parent is NOT my marker then look inside to find it's position.
    if (marker !== target) {
        // Counting the dom elements
        // so that if an unknown element gets in the collection we won't blow up.
        // But this means we need to count everything for the off chance this condition happens.
        var elements = this.getAllElements(component);
        var length = elements.length;
        // Current is the last element in our component, or the marker.
        var current = marker;
        var totalElements = 0;

        // Count from the marker to the firstChild so we know what index we are at in the childNodes collection.
        while (current != null && current.previousSibling) {
            calculatedPosition++;

            // Move to the previous element and try again.
            current = current.previousSibling;
        }

        if (!target) {
            // Some existing components intendedly remove elements from DOM.
            // This could cause rendering issue if the element if a shared marker.
            current = elements[length-1];
        } else {
            // The elements order may be different between component elements collection and DOM,
            // so we need to find the real last child in the DOM.
            current = this.getLastSharedElementInCollection(elements, target.childNodes);
        }
        // Count all the elements in the DOM vs what we know.
        while (current != null) {
            // How many nodes between the last element this component owns
            // and the firstNode of the childNodes collection.
            totalElements++;

            // If we hit the marker, track the index of that component from the bottom.
            // The marker is part of the component, so count it as an element.
            if(current === marker) {
                break;
            }

            // Move to the previous element and try again.
            current = current.previousSibling;
        }

        // The position offset by the amount of untraced nodes.
        calculatedPosition = calculatedPosition + (totalElements - length);
    }

    var components = updatedFacet.components;
    for (var i = 0; i < components.length; i++) {
        var info=components[i];
        var renderedElements=null;
        if (!info.component.isValid() && info.action !== 'unrender') {
            continue;
        }

        switch (info.action) {
            case "render":
                var containerId = component.globalId;
                if (info.component.containerComponentId !== containerId) {
                    info.component.setContainerComponentId(containerId);
                }

                renderedElements = this.render(info.component);
                if (updatedFacet.useFragment) {
                    ret = ret.concat(renderedElements);
                    calculatedPosition += renderedElements.length;
                } else if (renderedElements.length) {
                    ret = ret.concat(renderedElements);
                    if (!target) {
                        $A.warning("Rendering Error: The element for the following component was removed from the DOM outside of the Aura lifecycle. " +
                                "We cannot render any further updates to it or its children.\nComponent: " + $A.clientService.getAccessStackHierarchy() +
                                " {" + component.getGlobalId() + "}");
                    } else {
                        nextSibling = target.childNodes[calculatedPosition];
                        this.insertElements(renderedElements, nextSibling||target, nextSibling, nextSibling);
                        calculatedPosition += renderedElements.length;
                    }
                }
                this.afterRenderStack.push(info.component);
                break;
            case "rerender":
                if (this.hasDirtyValue(info.component)) {
                    renderedElements = this.rerender(info.component);
                } else {
                    // This must use component.getElements() not this.getElements()
                    // Since we need a copy of the array.
                    renderedElements = this.getAllElementsCopy(info.component);
                }
                info.component.disassociateElements();
                this.associateElements(info.component, renderedElements);
                ret = ret.concat(renderedElements);
                calculatedPosition += renderedElements.length;
                break;
            case "unrender":
                marker = this.getMarker(component);

                // for html component, it should always has its own element as marker
                if (!this.isCommentMarker(marker) && component.getType() !== "aura:html") {

                    // if there will be a new marker from new rendered component, we should not move the marker to next sibling
                    // when unrendering the first component on facet
                    if (updatedFacet.fullUnrender || !marker.nextSibling || (info.oldIndex === 0 && updatedFacet.hasNewMarker)) {
                        var newMarker = this.createMarker(marker, "unrender facet: " + component.getGlobalId());
                        this.setMarker(component, newMarker);
                        // for the new comment marker
                        calculatedPosition += 1;
                    } else if (info.component.isValid()) {
                        this.moveSharedMarkerToSibling(component, info.component);
                    }

                }

                //JBUCH: HALO: TODO: FIND OUT WHY THIS CAN BE UNRENDERING A COMPONENTDEFREF AND FIX IT
                if ($A.util.isComponent(info.component) && info.component.isValid()) {
                    if (info.component.autoDestroy()) {
                        this.cleanComponent(info.component.getGlobalId());
                        info.component.destroy();
                    } else {
                        this.unrender(info.component);
                        info.component.disassociateElements();
                        this.cleanComponent(info.component.getGlobalId());
                    }
                }

                break;
        }
    }
    this.storeFacetInfo(component, updatedFacet.facetInfo);
    if (updatedFacet.useFragment) {
        nextSibling = target.childNodes[calculatedPosition];
        this.insertElements(ret, nextSibling || target, nextSibling, nextSibling);
    }

    // JBUCH: HALO: FIXME: THIS IS SUB-OPTIMAL, BUT WE NEVER WANT TO REASSOCIATE HTML COMPONENTS
    var type = component.getType();
    if (type !== "aura:html") {
        marker = this.getMarker(component);
        if (ret.length > 0 && marker !== ret[0]) {
            this.setMarker(component, ret[0]);
            // now clean up if necessary
            if (this.isCommentMarker(marker)) {
                this.moveReferencesToMarker(marker, ret[0]);
                this.removeElement(marker);
            }
        } else if (ret.length === 0 && marker) {
            // the marker should only be comment marker
            ret.push(marker);
        }

        component.disassociateElements();
        this.associateElements(component, ret);

        if (topVisit) {
            var updatedElements = this.getAllElements(component);
            // check if there's any elements update during rerender
            var updateContainer = updatedElements.length !== beforeRerenderElements.length;
            if (!updateContainer) {
                for (var n = 0; n < beforeRerenderElements.length; n++) {
                    if (beforeRerenderElements[n] !== updatedElements[n]) {
                        updateContainer = true;
                        break;
                    }
                }
            }

            if (updateContainer) {
                var container = component.getConcreteComponent().getContainer();
                this.updateContainerElements(container, oldElementContainerPositions, beforeRerenderElements, updatedElements);
            }
        }
    }

    if (topVisit) {
        this.rerenderFacetTopVisit = true;
    }

    return ret;
};

/**
 * Update component's marker to componentOnFacet's sibling element if component shares same marker with componentOnFacet.
 * It also updates component's container chain if the containers share the marker as well.
 *
 * This function is used in rerenderFacet() when unrendering component on facet.
 */
AuraRenderingService.prototype.moveSharedMarkerToSibling = function(component, componentOnFacet) {
    var marker = this.getMarker(component);
    var allElements = this.getAllElements(componentOnFacet);
    // do no need to move marker if the component does not share marker with the component on its facet
    if (allElements[0] !== marker) {
        return;
    }

    // We can't just assume the nextSibling, it could belong to what we're unrendering.
    // Find the next element that this unrendering component does not own.
    var count = allElements.length - 1;
    var nextSibling = marker.nextSibling;
    while (count && nextSibling.nextSibling) {
        nextSibling = nextSibling.nextSibling;
        count--;
    }

    this.setMarker(component, nextSibling);
    // If old marker is still a shared marker, the shared marker in container chain may need to be updated as well.
    // Otherwise, a comment marker will be inserted for conatiners which share the old marker when componentOnFacet gets destroyed.
    if (this.isSharedMarker(marker)) {
        var container = component.getConcreteComponent().getContainer();
        while (container) {
            var concrete = container.getConcreteComponent();
            if (concrete.getType() === "aura:html") {
                break;
            }

            if (this.getMarker(concrete) === marker) {
                // We assume that nextSibling exists. If this function can be called without nextSibling check,
                // use the current marker of 'component' to update container's marker
                this.setMarker(concrete, nextSibling);
            } else {
                // the container does not share the old marker
                break;
            }
            container = concrete.getContainer();
        }
    }
};

/**
 * Find the element which is the last element in the DOM from component elements collection.
 * @private
 */
AuraRenderingService.prototype.getLastSharedElementInCollection = function(cmpElements, domElements) {
    if (!cmpElements || !domElements) {
        return null;
    }

    var lastElement = null;
    var largestIndex = -1;
    for (var i = 0, len = cmpElements.length; i < len; i++) {
        var element = cmpElements[i];
        var index = Array.prototype.indexOf.call(domElements, element);
        if (index > largestIndex) {
            largestIndex = index;
            lastElement = element;
        }
    }

    return lastElement;
};

/**
 * @param {Component} component - the component to be found from containers
 * @returns {Array} an arry of indexes that indicate where the component's elements are on the containers, from the bottom (direct) container to the top one
 */
AuraRenderingService.prototype.findElementsPositionFromContainers = function(component) {
    var indexSet = [];
    var visited = {};

    var allElements = this.getAllElements(component);
    var concrete = component.getConcreteComponent();

    // it is possible to set a container component to child's component's attribute
    visited[concrete.getGlobalId()] = true;
    this.collectElementPositionsFromContainers(concrete, allElements[0], indexSet, visited);

    return indexSet;
};

/**
 * Recursively traverse a component's container chain to collect the positions of the elements on containers
 *
 * @param {Component} concreteComponent - the component which contains the element
 * @param {HTMLElement} element - the element to find in container component
 * @param {Array} indexSet - an arry to store the indexes that indicate where the element is on the containers, from the bottom (direct) container to the top one
 * @param {Object} visited - an map to track the components have been visited
 */
AuraRenderingService.prototype.collectElementPositionsFromContainers = function(concreteComponent, element, indexSet, visited) {

    var container = concreteComponent.getContainer();
    if (!container) {
        return;
    }

    var concrete = container.getConcreteComponent();
    var globalId = concrete.getGlobalId();
    if ((concrete.getType() === "aura:html" && concrete["helper"].canHaveBody(concrete)) ||
            concrete.isRendered() === false || visited[globalId] === true) {
        return;
    }

    var allElements = this.getAllElements(concrete);
    var index = allElements.indexOf(element);
    if (index < 0) {
        $A.log("AuraRenderingService.collectElementPositionsFromContainers(): Something is wrong. Container is missing children's elements");
        return;
    }

    indexSet.push(index);
    visited[globalId] = true;
    this.collectElementPositionsFromContainers(concrete, element, indexSet, visited);
};

/**
 * Update elements through container chain.
 * When a dirty component gets rerendered, all containers of the component need to update their elements set accordingly.
 *
 * @param {Component} container - the direct container of the elements render component
 * @param {Array} insertPositions - the old elements positions in the container's elements set, from the bottom (direct) container to the top one
 * @param {Array} oldElements - the elements before rerendering
 * @param {Array} updatedElements - the updated elements after rerendering
 */
AuraRenderingService.prototype.updateContainerElements = function(container, insertPositions, oldElements, updatedElements) {
    if (!container || insertPositions.length === 0) {
        return;
    }

    var concrete = container.getConcreteComponent();
    // stop updating elements for container chain if it is a HtmlComponent which can have body.
    // this needs to match the render logic.
    if ((concrete.getType() === "aura:html" && concrete["helper"].canHaveBody(concrete)) ||
            concrete.isRendered() === false) {
        return;
    }

    var containerUpdatedElements = this.getAllElementsCopy(concrete);

    var index = insertPositions.shift();
    Array.prototype.splice.apply(containerUpdatedElements, [index, oldElements.length].concat(updatedElements));

    concrete.disassociateElements();
    this.associateElements(concrete, containerUpdatedElements);

    // if the first element gets updated, marker needs to be reset
    if (containerUpdatedElements[0] && containerUpdatedElements[0] !== this.getMarker(concrete)) {
        this.setMarker(concrete, containerUpdatedElements[0]);
    }

    this.updateContainerElements(concrete.getContainer(), insertPositions, oldElements, updatedElements);
};

/**
 * @public
 * @param {Component} cmp the component for which we are unrendering the facet.
 * @param {Component} facet the facet to unrender.
 * @export
 */
AuraRenderingService.prototype.unrenderFacet = function(cmp,facet) {
    if (cmp._facetInfo) {
        var facetInfo = [];
        // If in the process of destroying
        if(cmp.destroyed === -1 && cmp.getType()!=="aura:expression") {
            var existing = cmp._facetInfo;
            for(var i=0;i<existing.length;i++) {
                if(existing[i].autoDestroy()) {
                    existing[i].destroy();
                } else {
                    facetInfo.push(existing[i]);
                }
            }
        } else {
            facetInfo = cmp._facetInfo;
        }
        this.unrender(facetInfo);
        cmp._facetInfo = null;
    }

    if(facet) {
        this.unrender(facet);
    }

    var elements = this.getAllElements(cmp);
    var element;
    if(elements) {
        var globalId = cmp.getGlobalId();
        for(var c=elements.length-1;c>=0;c--) {
            element = elements[c];
            this.removeMarkerReference(element, globalId);
            this.removeElement(element, cmp);
        }
    }

    cmp.disassociateElements();
};

/**
 * Get a marker for a component.
 *
 * @public
 * @param {Component} cmp the component for which we want a marker.
 * @return the marker.
 * @export
 */
AuraRenderingService.prototype.getMarker = function(cmp){
    if(!cmp||cmp.destroyed===1) { return null; }

    return cmp.getConcreteComponent()._marker;
};

AuraRenderingService.prototype.setMarker = function(cmp, newMarker) {
    if (!cmp) {
        return;
    }

    var concrete = cmp.getConcreteComponent();
    var oldMarker = this.getMarker(concrete);

    // Shouldn't hit this. I can't hit it anymore.
    if (oldMarker === newMarker) {
        return;
    }

    // Html and Text Markers are special parts of the framework.
    // They always have a 1 to 1 mapping from component to element|textnode, and will never
    // use a comment marker. So no need to add overhead of tracking markers just for these component types.
    var type = cmp.getType();
    if (type !== "aura:html") {
        $A.renderingService.addMarkerReference(newMarker, concrete.getGlobalId());
    }
    if (oldMarker) {
        $A.renderingService.removeMarkerReference(oldMarker, concrete.getGlobalId());
    }

    // Clear it out!
    if (!newMarker) {
        concrete._marker = null;
    } else {
        concrete._marker = newMarker;
    }
};

/**
 * @protected
 * @param expression the expression to mark as dirty.
 * @param cmp the owning component.
 */
AuraRenderingService.prototype.addDirtyValue = function(expression, cmp) {
    this.needsCleaning = true;
    if (cmp && cmp.isValid() && cmp.isRendered()) {
        var id = cmp.getGlobalId();
        var list = this.dirtyComponents[id];
        if (!list) {
            list = this.dirtyComponents[id] = {};
            this.dirtyComponentIds.push(id);
        }
        while(expression.indexOf('.')>-1){
            list[expression]=true;
            expression=expression.substring(0,expression.lastIndexOf('.'));
        }
    }
};

/**
 * Does a component have a dirty value?.
 *
 * Only used by component to figure out if it is dirty... Maybe we should move this to component?
 *
 * @protected
 * @param cmp the component to check.
 */
AuraRenderingService.prototype.hasDirtyValue = function(cmp){
   return this.dirtyComponents.hasOwnProperty(cmp.getGlobalId());
};

/**
 * @protected
 */
AuraRenderingService.prototype.isDirtyValue = function(expression, cmp) {
    if (cmp && cmp.isValid()) {
        var id = cmp.getGlobalId();
        var list = this.dirtyComponents[id];
        if (list && list[expression]){
            return true;
        }
    }
    return false;
};

/**
 * Rerender all dirty components.
 *
 * Called from ClientService when we reach the top of stack.
 *
 * @protected
 * @export
 */
AuraRenderingService.prototype.rerenderDirty = function(stackName) {
    if (this.needsCleaning) {
        var maxiterations = 1000;

        // #if {"modes" : ["PTEST","STATS"]}
        var allRerendered = [],
            startTime,
            cmpsWithWhy = {
            "stackName" : stackName,
            "components" : {}
        };
        // #end

        //KRIS: HALO:
        // If any components were marked dirty during a component rerender than
        // this.needsCleaning will be true.
        // maxiterations to prevent run away rerenderings from crashing the browser.
        while(this.needsCleaning && maxiterations) {
            var dirty = [];
            this.needsCleaning = false;
            maxiterations--;

            while(this.dirtyComponentIds.length) {
                var id = this.dirtyComponentIds.shift();
                var cmp = $A.componentService.get(id);

                // uncomment this to see what's dirty and why. (please don't delete me again. it burns.)
                // $A.log(cmp.toString(), this.dirtyComponents[id]);

                if (cmp && cmp.isValid() && cmp.isRendered()) {
                    // We assert that we are not unrendering, as we should never be doing that, but we then check again, as in production we want to
                    // avoid the bug.
                    // JBUCH: HALO: TODO: INVESTIGATE THIS, IT SEEMS BROKEN
                    // For the moment, don't fail miserably here. This really is bad policy to allow things to occur on unrender that cause a re-render,
                    // but putting in the assert breaks code, so leave it out for the moment.

                    // aura.assert(!cmp.isUnrendering(), "Rerendering a component during unrender");
                    if (!cmp.isUnrendering()) {
                        dirty.push(cmp);

                        // KRIS: HALO:
                        // Since we never go through the renderFacet here, we don't seem
                        // to be calling afterRender
                        // But I could just be wrong, its complicated.
                        // Leaving this commented out for now till I can talk it over with JBUCH
                        //this.afterRenderStack.push(cmp);

                        // #if {"modes" : ["PTEST","STATS"]}
                        allRerendered.push(cmp);

                        cmpsWithWhy["components"][id] = {
                            "id" : id,
                            "descr" : cmp.getDef().getDescriptor().toString(),
                            "why" : this.dirtyComponents[id]
                        };
                        // #end
                    }
                } else {
                    this.cleanComponent(id);
                }
            }

            // #if {"modes" : ["STATS"]}
            startTime = startTime || (new Date()).getTime();
            // #end

            if (dirty.length) {
                this.rerender(dirty);
            }
        }

        //KRIS: HALO:
        // Somehow we did over 1000 rerenderings. Not just 1000 components, but one
        // component caused a rerender that caused a rerender, and on and on for 1000 times.
        $A.assert(maxiterations, "Max Callstack Exceeded: Rerendering loop resulted in to many rerenderings.");

        // #if {"modes" : ["PTEST","STATS"]}
        if (allRerendered.length) {
            cmpsWithWhy["renderingTime"] = (new Date()).getTime() - startTime;
            this.statsIndex["rerenderDirty"].push(cmpsWithWhy);
        }
        // #end
        $A.eventService.getNewEvent("markup://aura:doneRendering").fire();
    }
};

/**
 * @deprecated
 * @protected
 */
AuraRenderingService.prototype.removeDirtyValue = function(value, cmp) {
    if (cmp && cmp.isValid()) {
        var id = cmp.getGlobalId();
        var dirtyAttributes = this.dirtyComponents[id];
        if (dirtyAttributes) {
            if (dirtyAttributes[value]) {
                delete dirtyAttributes[value];
            }

            if ($A.util.isEmpty(dirtyAttributes)) {
                delete this.dirtyComponents[id];
                for (var i = 0; i < this.dirtyComponentIds.length; i++) {
                    if (this.dirtyComponentIds[i] === id) {
                        return this.dirtyComponentIds.splice(i, 1);
                    }
                }
            }
        }
    }
};

//#if {"modes" : ["PTEST","STATS"]}
AuraRenderingService.prototype.statsIndex = {
    "afterRender": [],
    "render": [],
    "rerender": [],
    "rerenderDirty": [],
    "unrender": []
};
//#end
//
AuraRenderingService.prototype.cleanComponent = function(id) {
    delete this.dirtyComponents[id];
};

/**
 * @private
 * @param things either an array or an item.
 * @return an array.
 */
AuraRenderingService.prototype.getArray = function(things) {
    if (!$A.util.isArray(things)) {
        return things?[things]:[];
    }
    return things;
};

/**
 * If a renderer returned a string, create html elements from that string.
 *
 * Returns an elements array, either the original one passed in or a new one
 * if "elements" passed in was a string, not an array.
 *
 * @private
 */
AuraRenderingService.prototype.evalStrings = function(elements) {
    if ($A.util.isString(elements)) {
        elements=$A.util.createElementsFromMarkup(elements);
    }
    return elements || [];
};

AuraRenderingService.prototype.finishRender = function(cmp, elements) {
    elements = this.evalStrings(elements);

    this.associateElements(cmp, elements);

    cmp.setRendered(true);

    this.cleanComponent(cmp.getGlobalId());

    return elements;
};

/**
 * Insert elements to the DOM, relative to a reference node,
 * by default as its last child.
 *
 * @private
 */
AuraRenderingService.prototype.insertElements = function(elements, refNode, asSibling, asFirst) {
    if (refNode) {
        if (asSibling) {
            if (asFirst) {
                $A.util.insertBefore(elements, refNode);
            } else {
                $A.util.insertAfter(elements, refNode);
            }
        } else {
            if (asFirst) {
                $A.util.insertFirst(elements, refNode);
            } else {
                $A.util.appendChild(elements, refNode); // Default
            }
        }
    }
};

/**
 * Calculates the flavor css class name for a component instance and element.
 * @private
 */
AuraRenderingService.prototype.getFlavorClass = function(cmp) {
    var flavor = null; // keep in mind here, flavor may get set to "" if it was given a value of {!remove}
    var staticFlavorable = cmp.isFlavorable(); // aura:flavorable="true" on html elements
    var dynamicFlavorable = cmp.getDef().isDynamicallyFlavorable(); // dynamicallyFlavorable="true" on cmp def
    var valueProvider = dynamicFlavorable ? cmp : cmp.getComponentValueProvider();

    if (valueProvider && (staticFlavorable || dynamicFlavorable)) {
        if (valueProvider.getConcreteComponent()) { // check if flavor of an extensible cmp was set on child cmp instance
            flavor = valueProvider.getConcreteComponent().getFlavor();
        }

        if ($A.util.isUndefinedOrNull(flavor)) {
            flavor = valueProvider.getFlavor();
        }

        if (!$A.util.isUndefinedOrNull(flavor) && $A.util.isExpression(flavor)) { // deal with expressions
            flavor = flavor.evaluate();
        }

        if (staticFlavorable && !$A.util.isUndefinedOrNull(flavor)) {
            return $A.util.buildFlavorClass(valueProvider, flavor);
        } else if (dynamicFlavorable) {
            var flavorClasses = [];
            var dynamicallyFlavorableDefs = cmp.getDef().getDynamicallyFlavorable();
            for (var i = 0, len = dynamicallyFlavorableDefs.length; i < len; i++) {
                var def = dynamicallyFlavorableDefs[i];
                var defFlavor = !$A.util.isUndefinedOrNull(flavor) ? flavor : def.getDefaultFlavor();
                if (!$A.util.isUndefinedOrNull(defFlavor)) {
                    flavorClasses.push($A.util.buildFlavorClass(def, defFlavor));
                }
            }

            return flavorClasses.join(" ");
        }
    }

    return null;
};

AuraRenderingService.prototype.addAuraClass = function(cmp, element){
    var concrete = cmp.getConcreteComponent();
    var className = concrete.getDef().getStyleClassName(); // the generic class name applied to all instances of this component
    var flavorClassName;

    if (className) {
        flavorClassName = this.getFlavorClass(concrete);
        if (flavorClassName) {
            className = className + flavorClassName;
        }

        $A.util.addClass(element, className);
        if (element["tagName"]) {
            element.setAttribute("data-aura-class",$A.util.buildClass(element.getAttribute("data-aura-class"),className));
        }
    } else if (concrete.isInstanceOf("aura:html")) { // only check html cmps (presuming this is faster) TODONM find a better way to short-circuit here
        // this is for nested flavorable elements (not at top level of cmp).
        flavorClassName = this.getFlavorClass(concrete, element);
        if (flavorClassName) {
            $A.util.addClass(element, flavorClassName);
            if (element["tagName"]) {
                element.setAttribute("data-aura-class",$A.util.buildClass(element.getAttribute("data-aura-class"),flavorClassName));
            }
        }
    }
};

/**
 * Associate all of the elements with the component, and return a list of
 * pure elements - with no association objects wrapped around them.
 *
 * @private
 */
AuraRenderingService.prototype.associateElements = function(cmp, elements) {
    elements = this.getArray(elements);

    var len = elements.length;
    var element;
    for (var i = 0; i < len; i++) {
        element = elements[i];

        if (!this.isCommentMarker(element)) {
            this.addAuraClass(cmp, element);
        }

        cmp.associateElement(element);
    }
};

/**
 * Create a new Comment marker optinally before the specified target and for the specified reason.
 * Often the reason is something relating to what was unrendered or rendered such as a globalId.
 *
 * @param {HTMLElement} target - the target element where the created marker is placed before
 * @param {string} reason - the text content of the marker, to help understand when or why this marker get created
 *
 * @private
 */
AuraRenderingService.prototype.createMarker = function(target, reason) {
    var node = document.createComment(reason);
    node.aura_marker = true;
    if (target) {
        $A.util.insertBefore(node, target);
    }
    return node;
};

/**
 * Basically was this node created by the createMarker() function above.
 * Since we use comment markers as placement in the dom for non-rendered components and expressions
 * We often branch logic on wether the element is a comment marker or not.
 * @private
 */
AuraRenderingService.prototype.isCommentMarker = function(node){
    return node&&node.aura_marker;
};

/**
 * If you use component.getElements() it will normalize the array, but also slice it to give you a copy.
 * When in trusted code that is aware of this situation, we can avoid the cost of slicing the array.
 *
 * @private
 */
AuraRenderingService.prototype.getElements = function(component) {
    // avoid a slice of the elements collection
    return component.getConcreteComponent().elements || [];
};

/**
 * Includes all the DOM elements the component output as part of its rendering cycle.
 * This method also returns the comment markers output as part of the component rendering cycle.
 * If you do not want the comment nodes returned to you (your known set of dom nodes), use cmp.getElements() or renderingService.getElements(component)
 */
AuraRenderingService.prototype.getAllElements = function(component) {
    return component.getConcreteComponent().allElements || [];
};

/**
 * Similar to getAllElements, but this method will copy the allElements collection and return it. This allows you to modify the collection for processing
 * during the renderingService without worring about mutating the component elements collection.
 */
AuraRenderingService.prototype.getAllElementsCopy = function(component) {
    return component.getConcreteComponent().allElements.slice(0) || [];
};

/**
 * Get a uniqueID to identify different HTML elements by.
 * This method tries to use the data-rendered-by attribute first if possible.
 * If not (such as comment nodes) then we'll just append our own data attribute.
 * We need this so we can maintain a map of references to a component without a reference to the component.
 *
 * @private
 */
AuraRenderingService.prototype.getUid = function(element) {
    if(element.nodeType === 1) {
        // Try to use the rendered-by attribute which should be on almost everything
        // The times it won't will probably be elements generated in the renderer by the component developer
        var id = $A.util.getDataAttribute(element, $A.componentService.renderedBy);
        if(id !== null) {
            return id;
        }

        // Try to use data attributes for our unique ID of our own creation to the element as the fallback.
        id = $A.util.getDataAttribute(element, this.DATA_UID_KEY);
        if(id!==null) {
            return id;
        }
    }
    return element[this.DATA_UID_KEY];
};

/**
 * Assign a new unique id to the specified element.
 * The unique ID is just an incrementing number on the service.
 *
 * @private
 */
AuraRenderingService.prototype.newUid = function(element) {
    var nextUid = this.uid++;
    var success = null;

    if(element.nodeType === 1) {
        success = $A.util.setDataAttribute(element, this.DATA_UID_KEY, nextUid);
    }

    // Couldn't set the data attribute, happens for some HTML elements.
    if(success === null) {
        element[this.DATA_UID_KEY] = nextUid;
    }

    return nextUid;
};

/**
 * Get the unique id for an element. If it does not have one, generate one and return that.
 * Uses a combination of getUid() and newUid().
 *
 * @private
 */
AuraRenderingService.prototype.resolveUid = function(element) {
    var uid = this.getUid(element);
    if(uid === null || uid === undefined) {
        return this.newUid(element);
    }
    return uid;
};

/**
 * The marker can be any dom node. This method tracks that that dom node is being
 * referenced by the component with the specified globalid
 *
 * @private
 */
AuraRenderingService.prototype.addMarkerReference = function(marker, globalId) {
    if (!marker || !globalId) {
        return;
    }
    var uid = this.resolveUid(marker);
    var existing = this.markerToReferencesMap[uid];
    if(!existing) {
        this.markerToReferencesMap[uid] = existing = new this.ReferenceCollection();
    }
    existing.add(globalId);
};

/**
 * The specified dom node (marker) is no longer being used by the component with the specified global id.
 *
 * @private
 */
AuraRenderingService.prototype.removeMarkerReference = function(marker, globalId) {
    if(!marker||!globalId) { return; }

    var resolvedMarker = this.resolveUid(marker);
    var references = this.markerToReferencesMap[resolvedMarker];

    if (!$A.util.isUndefinedOrNull(references)) {
        references.delete(globalId, function(refs) {
            this.removeMarkerFromReferenceMap(resolvedMarker, refs);
        }.bind(this));
    }
};

/**
 * Remove the reference marker from the markerToReferencesMap object.
 *
 * @private
 */
AuraRenderingService.prototype.removeMarkerFromReferenceMap = function(resolvedMarker, refs) {
    if(!resolvedMarker) { return; }

    if($A.util.isUndefinedOrNull(refs) || $A.util.isEmpty(refs)) {
        this.markerToReferencesMap[resolvedMarker] = null;
        delete this.markerToReferencesMap[resolvedMarker];
    }
};

/**
 * Get a collection of IDs who are using the specified element as a marker.
 * If the element is being removed, we'll want to move those references to another element or a comment marker.
 *
 * @private
 */
AuraRenderingService.prototype.getMarkerReferences = function(marker) {
    if(!marker) {
        return null;
    }
    return this.markerToReferencesMap[this.resolveUid(marker)];
};

/**
 * Carefully remove the marker from the container.
 * If we're trying to remove a shared comment marker, we do nothing since others are using it.
 * If the parent isn't unrendering or is being destroyed, we won't do anything either since the container will have its dom node removed and that will remove all its children from the dom.
 *
 * @private
 */
AuraRenderingService.prototype.removeElement = function(marker, container) {
    //var container = component.getConcreteComponent().getContainer();
    //if(!container || !container.getConcreteComponent().isUnrendering()) {
    var concrete = container && container.getConcreteComponent();
    if (!concrete || !concrete.isUnrendering()) {
        if (this.isSharedMarker(marker)) {
            // No point in moving everything to another comment marker.
            if (this.isCommentMarker(marker)) { return; }

            // Move all the past references to a comment!
            this.moveReferencesToMarker(marker);
        } else if (concrete && concrete.destroyed === -1 && !this.isCommentMarker(marker)) {
            // this element is going away anyway since the container is being destroyed.
            return;
        }

        $A.util.removeElement(marker);
    }
};

/**
 * All the components who are using the specified dom node as a marker need to now be moved to a comment marker.
 * This method doesn't check if you're moving from one comment node to another. That would be a waste of time, so
 * be aware you should verify that first.
 *
 * @private
 */
AuraRenderingService.prototype.moveReferencesToMarker = function(marker, newMarker) {
    var references = this.getMarkerReferences(marker);
    var isSwap = !!newMarker;
    newMarker = newMarker || this.createMarker(null, "unrender marker: " + marker.nodeValue);

    if (references) {
        var collection = references.get();
        for(var c = collection.length - 1; c >= 0; c--) {
            var cmp = $A.getComponent(collection[c]);
            if (!cmp || cmp.destroyed) {
                continue;
            }

            this.setMarker(cmp, newMarker);
            var concrete = cmp.getConcreteComponent();
            var elements = concrete.allElements;
            var position;
            if (!elements) {
                concrete.elements = concrete.allElements = [newMarker];
            } else {
                position = elements.indexOf(marker);
                if (position === -1) {
                    // This seems like a problem, lets try to see if it happens
                    $A.warning("AuraRenderingService.moveReferencesToMarker(): Missing marker on component " + cmp);
                    // insert the new marker to behind if something is wrong
                    position = elements.length;
                }
                var filteredElements = [];

                elements[position] = newMarker;
                for (var i=0;i<elements.length;i++) {
                    if (!elements[i].aura_marker) {
                        filteredElements.push(elements[i]);
                    }
                }
                concrete.elements = filteredElements;
            }
        }
    }

    // If this is a swap by interop, interop would take care of DOM node replacement so no need for insertBefore
    // If the marker is actually being used by others, then go ahead and put it in the dom.
    if(!isSwap && this.isSharedMarker(newMarker)) {
        $A.util.insertBefore(newMarker, marker);
    }
};

/**
 * Are multiple components using this as a marker?
 * Shared markers need to have their other references moved before being able to remove the marker node from the dom.
 *
 * @private
 */
AuraRenderingService.prototype.isSharedMarker = function(marker) {
    var references = this.getMarkerReferences(marker);

    return references? references.size() > 0 : false;
};

/**
 * The ReferenceCollection is a data structure for tracking references from components to dom nodes.
 * Since it is a many (components() to one element mapping, this is necessary to track whos using what.
 * The collection will optimize to not create an array at first. Only after you've added more than one reference
 * will the array be created.
 *
 * Lastly, this collecton acts just like a Set(). You cannot add the same value twice, which helps with our reference counting logic.
 *
 * @private
 */
AuraRenderingService.prototype.ReferenceCollection = function() {
    // this.references = "" || [];
};

AuraRenderingService.prototype.ReferenceCollection.prototype.isCollection = false;

AuraRenderingService.prototype.ReferenceCollection.prototype.add = function(value){
    // Only track references
    if(typeof value !== "string") { return; }

    if(this.has(value)) {
        // Either we act like a set, or we make sure it doesn't dupe in consumption.
        // Latter is better for perf, maybe throw and track if its an issue?
        return;
    }

    if(!this.references) {
        this.references = value;
    } else if(!this.isCollection) {
        if(this.references !== value) {
            this.references = [this.references, value];
            this.isCollection = true;
        }
    } else {
        this.references.push(value);
    }
};

AuraRenderingService.prototype.ReferenceCollection.prototype.delete = function(value, callback){
    if(typeof value !== "string") {
        return;
    }
    if(this.isCollection) {
        var index = this.references.indexOf(value);
        if(index > -1) {
            this.references.splice(index, 1);
        }
    }
    if(this.references === value) {
        this.references = null;
    }
    callback(this.references);
};

AuraRenderingService.prototype.ReferenceCollection.prototype.has = function(value){
    if(!this.isCollection) {
        return this.references === value;
    }
    if(this.references) {
        return this.references.indexOf(value) !== -1;
    }
    return false;
};

AuraRenderingService.prototype.ReferenceCollection.prototype.size = function(){
    if(this.references) {
        if(typeof this.references === "string") {
            return 1;
        } else {
            return this.references.length;
        }
    }
    return 0;
};

AuraRenderingService.prototype.ReferenceCollection.prototype.get = function(index) {
    if(index === undefined) {
        if(this.isCollection) {
            return this.references;
        } else {
            return [this.references];
        }
    }
    return this.references[index];
};

Aura.Services.AuraRenderingService = AuraRenderingService;
