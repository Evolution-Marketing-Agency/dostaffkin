import { Component, signal, OnInit, AfterViewInit } from '@angular/core';
import { Header } from '../../header/header';
import { DELIVERY_SIZES, DELIVERY_SPEEDS } from './order.config';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { UpperCasePipe } from '@angular/common';
import { DeliveryApi } from '../../services/delivery-api';

// Объявляем ymaps, чтобы TypeScript не ругался
declare var ymaps: any;

@Component({
  selector: 'app-order',
  imports: [Header, UpperCasePipe, ReactiveFormsModule],
  templateUrl: './order.html',
  styleUrl: './order.css',
})
export class Order implements OnInit, AfterViewInit {
  public readonly sizes = DELIVERY_SIZES;
  public readonly speeds = DELIVERY_SPEEDS;

  public map: any;
  private mapRoute: any;

  public routeForm: FormGroup;
  public orderForm: FormGroup;

  public orderId = signal<string | null>(null);
  public calculationResult = signal<any | null>(null);

  constructor(private formBuilder: FormBuilder, private deliveryApi: DeliveryApi) {
    // Форма маршрута
    this.routeForm = this.formBuilder.group({
      from: ['', Validators.required],
      to: ['', Validators.required],
      size: ['xs', Validators.required],
      speed: ['regular', Validators.required]
    });

    // Форма контактов. Validators.pattern(/\S/) защищает от ввода одних пробелов
    this.orderForm = this.formBuilder.group({
      name: ['', [Validators.required, Validators.pattern(/\S/)]],
      phone: ['', [Validators.required, Validators.pattern(/\S/)]],
      comment: ['']
    });
  }

  ngOnInit() {
    ymaps.ready(() => {
      // Подключаем подсказки адресов (SuggestView)
      const fromSuggest = new ymaps.SuggestView('from');
      fromSuggest.events.add('select', (event: any) => {
        this.routeForm.controls['from'].setValue(event.get('item')?.value ?? '');
      });

      const toSuggest = new ymaps.SuggestView('to');
      toSuggest.events.add('select', (event: any) => {
        this.routeForm.controls['to'].setValue(event.get('item')?.value ?? '');
      });
    });
  }

  ngAfterViewInit() {
    // Инициализируем карту, когда DOM уже отрисован
    ymaps.ready(() => {
      this.map = new ymaps.Map('map', {
        center: [55.751244, 37.618423],
        zoom: 5,
        controls: ['zoomControl']
      });
    });
  }

  public selectSize(size: string) {
    this.routeForm.controls['size'].setValue(size);
  }

  public selectSpeed(speed: string) {
    this.routeForm.controls['speed'].setValue(speed);
  }

  public calculate() {
    this.calculationResult.set(null);

    if (!this.map || this.routeForm.invalid) {
      return;
    }

    const { from, to, size, speed } = this.routeForm.getRawValue();

    // Удаляем старый маршрут, если он был
    if (this.mapRoute) {
      this.map.geoObjects.remove(this.mapRoute);
      this.mapRoute = null;
    }

    // Строим новый маршрут
    this.mapRoute = new ymaps.multiRouter.MultiRoute(
      { referencePoints: [from, to] },
      { boundsAutoApply: true } // true — чтобы карта автоматически центрировалась под маршрут
    );
    this.map.geoObjects.add(this.mapRoute);

    // Слушаем успешное построение маршрута
    this.mapRoute.model.events.add('requestsuccess', () => {
      try {
        const activeRoute = this.mapRoute.getActiveRoute();
        if (!activeRoute) {
          return this.failedCalculation();
        }

        const km = activeRoute.properties.get('distance').value / 1000;
        const sizeValue = size ?? '';
        const sizeConfig = this.sizes.find((item) => item.value === sizeValue);
        
        if (!sizeConfig) {
          return this.failedCalculation();
        }

        let total = Math.max(sizeConfig.min, Math.ceil(km * sizeConfig.rate));
        let duration = Math.min(30, 1 + Math.ceil(km / 80));

        if (speed === 'fast') {
          total = Math.ceil(total * 1.15);
          duration = Math.ceil(duration - (duration * 0.30));
        }

        this.calculationResult.set({
          from, // Эти поля теперь точно должны быть заполнены, если маршрут построился
          to,
          size,
          distance: km.toFixed(1),
          duration,
          rate: sizeConfig.rate,
          total,
          speed
        });
      } catch (err) {
        console.error('Ошибка расчета:', err);
        this.failedCalculation();
      }
    });

    // Слушаем ошибку построения маршрута
    this.mapRoute.model.events.add('requestfail', () => {
      this.failedCalculation();
    });
  }

  private failedCalculation() {
    this.calculationResult.set(null);
    alert('Не удалось построить маршрут. Убедитесь, что вы выбрали правильные адреса из подсказок.');
  }

  public submitOrder() {
    const calculation = this.calculationResult();
    
    // 1. Проверяем, есть ли расчет
    if (!calculation) {
      alert('Сначала рассчитайте стоимость, чтобы оформить заявку');
      return;
    }

    const { name, phone, comment } = this.orderForm.getRawValue();
    
    // 2. Чистим данные от лишних пробелов
    const cleanName = (name ?? '').trim();
    const cleanPhone = (phone ?? '').trim();
    const cleanComment = (comment ?? '').trim();

    // Очищаем телефон от всего, кроме цифр и плюса (серверы это любят)
    const formattedPhone = cleanPhone.replace(/[^\d+]/g, '');

    // 3. Жесткая проверка на пустоту
    if (!cleanName || !formattedPhone) {
      alert('Пожалуйста, корректно заполните имя и телефон');
      return;
    }

    // 4. Проверяем, что адреса не потерялись
    if (!calculation.from || !calculation.to) {
      alert('Ошибка маршрута. Выберите адреса из выпадающего списка.');
      return;
    }

    // 5. Формируем объект для отправки (Payload)
    const payload = {
      customer: { 
        name: cleanName, 
        phone: formattedPhone, 
        comment: cleanComment 
      },
      calculation: {
        from: calculation.from,
        to: calculation.to,
        distance: calculation.distance,
        duration: calculation.duration,
        rate: calculation.rate,
        total: calculation.total,
        size: calculation.size,
        speed: calculation.speed
      },
      createdAt: new Date().toISOString()
    };

    // Выводим в консоль то, что отправляем (для отладки ошибки 422)
    console.log('PAYLOAD ДЛЯ СЕРВЕРА:', JSON.stringify(payload, null, 2));

    // 6. Отправляем на сервер
    this.deliveryApi.createDelivery(payload).subscribe({
      next: (response: any) => {
        if (response && 'error' in response) {
          alert(response.error);
          return;
        }
        
        // Если сервер вернул id, показываем экран успеха
        this.orderId.set(response.id || 'OK'); 
      },
      error: (err: any) => {
        console.error('Ошибка сервера:', err);
        
        // Если сервер прислал детали ошибки в теле ответа
        let errorMessage = 'Не удалось отправить заявку.';
        if (err.error?.message) {
            errorMessage += ' ' + err.error.message;
        } else if (err.error?.errors) {
            // Выводим список недостающих полей, если сервер их прислал
            errorMessage += ' Проверьте поля: ' + JSON.stringify(err.error.errors);
        }
        
        alert(errorMessage);
      }
    });
  }
}