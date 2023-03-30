import * as html from "./unlit.js";
import { RangeSlider } from "/web-components/range-slider.js";

export class Sliders {
  constructor(slidersID, sliderDescriptions) {
    this.container = document.querySelector(`#${slidersID}`);
    this.setSliderDescriptions(sliderDescriptions);
  }

  addEventListener(eventName, handler, options) {
    this.container.addEventListener(eventName, handler, options);
  }

  _dispatchSlidersChangedEvent() {
    const event = new CustomEvent("slidersChanged", {
      bubbles: false,
      detail: this,
    });
    this.container.dispatchEvent(event);
  }

  setSliderDescriptions(sliderDescriptions) {
    this.container.innerHTML = ""; // Delete previous sliders
    for (const sliderInfo of sliderDescriptions) {
      if (sliderInfo.isDivider) {
        this.container.appendChild(html.hr({ class: "slider-divider" }));
      } else {
        const slider = new RangeSlider();
        slider.name = sliderInfo.name;
        slider.minValue = sliderInfo.minValue;
        slider.maxValue = sliderInfo.maxValue;
        slider.defaultValue = sliderInfo.defaultValue;
        slider.value = sliderInfo.defaultValue;
        slider.onChangeCallback = () => this._dispatchSlidersChangedEvent();
        this.container.appendChild(slider);
      }
    }
  }

  get values() {
    const values = {};
    for (const slider of this.container.children) {
      if (slider) {
        values[slider.name] = Number(slider.value);
      }
    }
    return values;
  }

  set values(values) {
    for (const slider of this.container.children) {
      if (!slider) {
        continue;
      }
      const value = values[slider.name];
      if (value !== undefined) {
        slider.value = values[slider.name];
      }
    }
  }
}
